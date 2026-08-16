const path = require('path')
const express = require('express')
const cron = require('node-cron')
const { createClient } = require('@supabase/supabase-js')

const {
  YT_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ACCESS_CODE,
  PORT = 3000
} = process.env

for (const [k, v] of Object.entries({ YT_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, ACCESS_CODE })) {
  if (!v) {
    console.error(`[fatal] 환경변수 ${k} 가 없습니다. .env.example 을 참고하세요.`)
    process.exit(1)
  }
}

// 서비스 키는 RLS 를 우회한다. 절대 클라이언트로 내보내지 않는다.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
})

// ---------------------------------------------------------------- YouTube API

const YT_BASE = 'https://www.googleapis.com/youtube/v3'

async function ytGet(endpoint, params) {
  const url = new URL(`${YT_BASE}/${endpoint}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  }
  url.searchParams.set('key', YT_API_KEY)

  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${endpoint} ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

// videos.list 는 한 번에 50개까지. id 를 나눠 던진다.
async function fetchVideoDetails(ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const data = await ytGet('videos', {
      part: 'snippet,statistics',
      id: chunk.join(',')
    })
    out.push(...(data.items ?? []))
  }
  return out
}

// ---------------------------------------------------------------- 저장

// 채널의 "업로드" 재생목록 ID. 한 번 알아내면 yt_watches 에 캐시한다.
// 캐시 컬럼이 아직 없어도 죽지 않고 매번 조회로 버틴다 (channels.list = 1 유닛).
async function uploadsPlaylistId(watch) {
  if (watch.uploads_playlist_id) return watch.uploads_playlist_id

  const data = await ytGet('channels', { part: 'contentDetails', id: watch.value })
  const id = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!id) throw new Error(`업로드 재생목록을 찾지 못했습니다 (${watch.value})`)

  const { error } = await supabase
    .from('yt_watches').update({ uploads_playlist_id: id }).eq('id', watch.id)
  if (error) {
    console.warn(`[collect] uploads_playlist_id 캐시 실패(컬럼 없음?): ${error.message}`)
  }
  watch.uploads_playlist_id = id
  return id
}

// ---------------------------------------------------------------- 채점

const EXCLUDED = -999

// 제목에 걸린 관심 키워드 목록
function matchedKeywords(title, includeKws) {
  const lower = (title ?? '').toLowerCase()
  return includeKws.filter((k) => lower.includes(k.toLowerCase()))
}

function scoreVideo(video, cfg, source) {
  const title = video.snippet?.title ?? ''
  const lower = title.toLowerCase()

  // 제외 키워드는 다른 점수를 다 무시하고 잘라낸다
  if (cfg.excludeKws.some((k) => lower.includes(k.toLowerCase()))) return EXCLUDED

  // 카테고리 필터가 하나라도 걸려 있으면 급상승은 그 안에서만 본다
  if (
    source === 'trending' &&
    cfg.categoryIds.length > 0 &&
    !cfg.categoryIds.includes(String(video.snippet?.categoryId ?? ''))
  ) {
    return EXCLUDED
  }

  let score = matchedKeywords(title, cfg.includeKws).length * 30
  if (source.startsWith('channel:')) score += 40
  else if (source.startsWith('keyword:')) score += 30
  return score
}

async function saveVideos(items, source, cfg) {
  if (items.length === 0) return 0

  const videoRows = items.map((v) => ({
    video_id: v.id,
    title: v.snippet?.title ?? '(제목 없음)',
    channel_id: v.snippet?.channelId ?? null,
    channel_title: v.snippet?.channelTitle ?? null,
    published_at: v.snippet?.publishedAt ?? null,
    category_id: v.snippet?.categoryId ?? null,
    // 최신값을 영상 행에도 둔다. 발굴 정렬·중앙값 계산이 스냅샷 전수 조회 없이 끝난다.
    views: Number(v.statistics?.viewCount ?? 0),
    like_count: Number(v.statistics?.likeCount ?? 0),
    comment_count: Number(v.statistics?.commentCount ?? 0),
    score: scoreVideo(v, cfg, source),
    source
  }))

  const { error: vErr } = await supabase
    .from('yt_videos')
    .upsert(videoRows, { onConflict: 'video_id' })
  if (vErr) throw vErr

  const snapRows = items.map((v) => ({
    video_id: v.id,
    views: Number(v.statistics?.viewCount ?? 0),
    likes: Number(v.statistics?.likeCount ?? 0),
    comments: Number(v.statistics?.commentCount ?? 0)
  }))

  const { error: sErr } = await supabase.from('yt_snapshots').insert(snapRows)
  if (sErr) throw sErr

  return items.length
}

// ---------------------------------------------------------------- 백카탈로그

const BACKFILL_MAX_PER_CHANNEL = 500 // 채널당 최대 보관 영상 수
const BACKFILL_UNIT_BUDGET = 260     // 1회 수집에서 백카탈로그에 쓸 유닛 상한
const PAGE = 50                      // playlistItems 한 페이지

// 이미 저장된 영상 수가 적은 채널부터 돈다. 별도 커서 컬럼 없이 순환이 된다.
async function channelBacklogState(channels) {
  const out = []
  for (const w of channels) {
    const { count } = await supabase
      .from('yt_videos')
      .select('video_id', { count: 'exact', head: true })
      .eq('channel_id', w.value)
    out.push({ watch: w, stored: count ?? 0 })
  }
  return out.sort((a, b) => a.stored - b.stored)
}

// 한 채널의 업로드 재생목록을 페이지네이션하며 아직 없는 영상만 채운다.
async function backfillChannel(w, cfg, budget) {
  let used = 0
  let pageToken
  let seen = 0
  let saved = 0

  while (seen < BACKFILL_MAX_PER_CHANNEL && used + 2 <= budget) {
    const playlistId = await uploadsPlaylistId(w)
    const list = await ytGet('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: PAGE,
      ...(pageToken ? { pageToken } : {})
    })
    used += 1

    const ids = (list.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean)
    seen += ids.length
    if (ids.length === 0) break

    // 이미 있는 영상은 상세를 다시 부르지 않는다 (스냅샷은 신작 수집에서 계속 쌓인다)
    const { data: known } = await supabase
      .from('yt_videos').select('video_id').in('video_id', ids)
    const haveSet = new Set((known ?? []).map((r) => r.video_id))
    const fresh = ids.filter((id) => !haveSet.has(id))

    if (fresh.length > 0) {
      const details = await fetchVideoDetails(fresh)
      used += Math.ceil(fresh.length / 50)
      saved += await saveVideos(details, `backfill:${w.value}`, cfg)
    }

    pageToken = list.nextPageToken
    if (!pageToken) break
  }

  return { used, saved, seen }
}

// 채널별 조회수 중앙값 대비 배율.
//
// 처음에는 JS 에서 계산해 upsert 했는데 한 건도 반영되지 않았다. PostgREST 의 upsert 는
// INSERT ... ON CONFLICT DO UPDATE 로 나가서, 충돌로 UPDATE 될 행이라도 제안 행이
// NOT NULL(title 등)을 만족해야 한다. video_id 와 multiple 만 보내면 거기서 걸린다.
// 행마다 값이 다르니 PostgREST update 로도 한 번에 못 쓴다. DB 함수로 넘겼다.
async function recomputeMultiples() {
  const { data, error } = await supabase.rpc('recompute_multiples')
  if (error) {
    console.warn(`[collect] 배율 계산 실패(함수 없음?): ${error.message}`)
    return 0
  }
  return data ?? 0
}

// ---------------------------------------------------------------- 수집

let lastRun = null

async function readSettings() {
  const { data } = await supabase
    .from('yt_watches').select('value').eq('type', 'setting').eq('active', true)
  const flags = new Set((data ?? []).map((r) => r.value))
  return { trendingOn: flags.has('trending_on') } // 기본 off
}

async function collect() {
  const started = Date.now()
  const report = { trending: 0, watches: 0, videos: 0, byWatch: {}, units: 0, errors: [] }
  console.log('[collect] 시작')

  // 채점에 쓸 설정을 먼저 읽는다 (급상승 카테고리 필터가 여기 달려 있다)
  let watches = []
  try {
    const { data, error } = await supabase
      .from('yt_watches').select('*').eq('active', true)
    if (error) throw error
    watches = data ?? []
  } catch (err) {
    console.error('[collect] 감시 목록 조회 실패:', err.message)
    report.errors.push(`감시 목록: ${err.message}`)
  }

  const cfg = {
    includeKws: watches.filter((w) => w.type === 'include_kw').map((w) => w.value),
    excludeKws: watches.filter((w) => w.type === 'exclude_kw').map((w) => w.value),
    categoryIds: watches.filter((w) => w.type === 'category').map((w) => String(w.value))
  }

  const settings = await readSettings()

  // a. 인기 급상승 — 기본은 꺼져 있다 (백카탈로그 발굴로 전략 전환)
  if (settings.trendingOn) {
    try {
      const data = await ytGet('videos', {
        part: 'snippet,statistics',
        chart: 'mostPopular',
        regionCode: 'KR',
        maxResults: 50
      })
      report.units += 1
      report.trending = await saveVideos(data.items ?? [], 'trending', cfg)
    } catch (err) {
      console.error('[collect] 인기 급상승 실패:', err.message)
      report.errors.push(`인기 급상승: ${err.message}`)
    }
  }

  const since = new Date(Date.now() - 14 * 864e5).toISOString()

  for (const w of watches) {
    if (w.type !== 'keyword' && w.type !== 'channel') continue // 나머지는 채점용 설정
    // 한 감시 대상이 실패해도 나머지는 계속한다
    try {
      let ids = []

      if (w.type === 'keyword') {
        // 키워드는 검색 말고 방법이 없다 (search.list = 100 유닛)
        const found = await ytGet('search', {
          part: 'snippet',
          type: 'video',
          maxResults: 25,
          q: w.value,
          order: 'viewCount',
          publishedAfter: since
        })
        ids = (found.items ?? []).map((i) => i.id?.videoId).filter(Boolean)
        report.units += 100
      } else {
        // 채널은 업로드 재생목록을 읽으면 1 유닛으로 끝난다
        const before = w.uploads_playlist_id
        const playlistId = await uploadsPlaylistId(w)
        if (!before) report.units += 1 // channels.list 는 최초 1회만
        const list = await ytGet('playlistItems', {
          part: 'contentDetails',
          playlistId,
          maxResults: 25
        })
        report.units += 1
        ids = (list.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean)
      }
      if (ids.length === 0) continue

      const details = await fetchVideoDetails(ids)
      report.units += Math.ceil(ids.length / 50)
      const saved = await saveVideos(details, `${w.type}:${w.value}`, cfg)
      report.videos += saved
      report.byWatch[w.label || w.value] = saved
      report.watches++
    } catch (err) {
      console.error(`[collect] 감시 "${w.label || w.value}" 실패:`, err.message)
      report.errors.push(`${w.label || w.value}: ${err.message}`)
    }
  }

  // c. 백카탈로그 — 저장량이 적은 채널부터 유닛 예산 안에서 과거를 파고든다
  const channels = watches.filter((w) => w.type === 'channel')
  if (channels.length > 0) {
    let budget = BACKFILL_UNIT_BUDGET
    report.backfill = {}
    try {
      for (const { watch, stored } of await channelBacklogState(channels)) {
        if (budget < 3) break
        if (stored >= BACKFILL_MAX_PER_CHANNEL) continue
        try {
          const r = await backfillChannel(watch, cfg, budget)
          budget -= r.used
          report.units += r.used
          if (r.saved > 0) report.backfill[watch.label || watch.value] = r.saved
        } catch (err) {
          console.error(`[collect] 백카탈로그 "${watch.label}" 실패:`, err.message)
          report.errors.push(`백카탈로그 ${watch.label}: ${err.message}`)
        }
      }
    } catch (err) {
      report.errors.push(`백카탈로그: ${err.message}`)
    }
  }

  // d. 채널별 중앙값 대비 배율 갱신
  try {
    report.multiples = await recomputeMultiples()
  } catch (err) {
    console.error('[collect] 배율 계산 실패:', err.message)
    report.errors.push(`배율: ${err.message}`)
  }

  lastRun = {
    at: new Date().toISOString(),
    ms: Date.now() - started,
    ...report
  }
  console.log('[collect] 완료', JSON.stringify(lastRun))
  return lastRun
}

// ---------------------------------------------------------------- 성장 판별

const DAY = 864e5

// 스냅샷 추이로 단기(이슈)/중기(유행)/장기(스테디)를 가른다.
// 스냅샷이 2개 미만이면 아직 추이를 못 잡으므로 '수집 중'.
function classify(video, snapshots) {
  if (!snapshots || snapshots.length < 2) {
    return { badge: '수집 중', kind: 'pending', latest: snapshots?.[0]?.views ?? 0, delta: null }
  }

  const sorted = [...snapshots].sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
  const latest = sorted[sorted.length - 1]

  // 24시간 전에 가장 가까운 스냅샷
  const target = new Date(latest.captured_at).getTime() - DAY
  let prev = sorted[0]
  for (const s of sorted.slice(0, -1)) {
    if (Math.abs(new Date(s.captured_at) - target) < Math.abs(new Date(prev.captured_at) - target)) {
      prev = s
    }
  }

  const hours = (new Date(latest.captured_at) - new Date(prev.captured_at)) / 36e5
  const delta = latest.views - prev.views
  const rate24 = hours > 0 ? (delta / hours) * 24 : 0

  const days = video.published_at
    ? Math.max((Date.now() - new Date(video.published_at)) / DAY, 0.5)
    : 999
  const avgDaily = latest.views / Math.max(days, 1)

  let badge = '중기 (유행)'
  let kind = 'mid'
  if (days <= 3 && rate24 > avgDaily * 2) {
    badge = '단기 (이슈)'
    kind = 'short'
  } else if (days >= 7 && rate24 >= avgDaily * 0.8) {
    badge = '장기 (스테디)'
    kind = 'long'
  }

  return { badge, kind, latest: latest.views, delta, days: Math.round(days) }
}

async function buildTracking(limit = 60) {
  const { data: videos, error } = await supabase
    .from('yt_videos')
    .select('*')
    .gte('score', 0) // 걸러진 영상은 추이만 쌓고 화면에는 내보내지 않는다
    .order('first_seen_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  if (!videos?.length) return []

  const { data: snaps, error: sErr } = await supabase
    .from('yt_snapshots')
    .select('video_id, views, captured_at')
    .in('video_id', videos.map((v) => v.video_id))
    .order('captured_at', { ascending: true })
  if (sErr) throw sErr

  const byVideo = {}
  for (const s of snaps ?? []) (byVideo[s.video_id] ??= []).push(s)

  return videos
    .map((v) => ({ ...v, ...classify(v, byVideo[v.video_id]) }))
    .sort((a, b) => (b.delta ?? -1) - (a.delta ?? -1))
}

// ---------------------------------------------------------------- 채널 ID 추출

async function resolveChannelId(input) {
  const raw = input.trim()

  const direct = raw.match(/(UC[A-Za-z0-9_-]{22})/)
  if (direct) return direct[1]

  const handle = raw.match(/@([A-Za-z0-9._-]+)/)
  if (handle) {
    const data = await ytGet('channels', { part: 'id', forHandle: `@${handle[1]}` })
    if (data.items?.[0]?.id) return data.items[0].id
  }

  // /c/이름, /user/이름 같은 옛 형태는 검색으로 (100 유닛)
  const name = raw.replace(/^https?:\/\/[^/]+\//, '').replace(/^(c|user)\//, '').split(/[/?]/)[0]
  if (name) {
    const data = await ytGet('search', { part: 'snippet', type: 'channel', q: name, maxResults: 1 })
    if (data.items?.[0]?.id?.channelId) return data.items[0].id.channelId
  }
  return null
}

// ---------------------------------------------------------------- 서버

const app = express()
app.use(express.json())

const COOKIE = 'yr_access'

function readCookie(req, name) {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

function authed(req) {
  return readCookie(req, COOKIE) === ACCESS_CODE
}

function requireAuth(req, res, next) {
  if (!authed(req)) return res.status(401).json({ error: '인증이 필요해요' })
  next()
}

app.get('/api/session', (req, res) => {
  res.json({ ok: authed(req) })
})

app.post('/api/login', (req, res) => {
  const { code } = req.body ?? {}
  if (code !== ACCESS_CODE) return res.status(401).json({ error: '접속 코드가 맞지 않아요' })
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; HttpOnly; SameSite=Lax`
  )
  res.json({ ok: true })
})

app.get('/api/discover', requireAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 2 * DAY).toISOString()
    const { data: videos, error } = await supabase
      .from('yt_videos')
      .select('*')
      .gte('score', 0)
      .gte('first_seen_at', since)
      .order('first_seen_at', { ascending: false })
      .limit(40)
    if (error) throw error
    if (!videos?.length) return res.json([])

    const { data: snaps } = await supabase
      .from('yt_snapshots')
      .select('video_id, views, captured_at')
      .in('video_id', videos.map((v) => v.video_id))
      .order('captured_at', { ascending: false })

    const latest = {}
    for (const s of snaps ?? []) if (!(s.video_id in latest)) latest[s.video_id] = s.views

    res.json(
      videos
        .map((v) => ({ ...v, views: latest[v.video_id] ?? 0 }))
        .sort((a, b) => b.views - a.views)
    )
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 💎 발굴 — 채널 중앙값 대비 배율이 높은 과거 영상
app.get('/api/dig', requireAuth, async (req, res) => {
  try {
    const { period = 'all', channel = 'all', min = '3' } = req.query
    const now = Date.now()

    // 게시 6개월~3년이 기본 범위
    const RANGES = {
      '6m-1y': [182, 365],
      '1y-2y': [365, 730],
      '2y+': [730, 1095],
      all: [182, 1095]
    }
    const [minDays, maxDays] = RANGES[period] ?? RANGES.all
    const newest = new Date(now - minDays * 864e5).toISOString()
    const oldest = new Date(now - maxDays * 864e5).toISOString()

    let q = supabase
      .from('yt_videos')
      .select('*')
      .gte('multiple', Number(min) || 3)
      .gte('published_at', oldest)
      .lte('published_at', newest)
      .gte('score', 0)
      .order('multiple', { ascending: false })
      .limit(80)
    if (channel !== 'all') q = q.eq('channel_id', channel)

    const { data, error } = await q
    if (error) throw error
    res.json(data ?? [])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 📡 신작 — 감시 채널의 최근 30일 영상
app.get('/api/fresh', requireAuth, async (req, res) => {
  try {
    const { data: chans } = await supabase
      .from('yt_watches').select('value').eq('type', 'channel')
    const ids = (chans ?? []).map((c) => c.value)
    if (ids.length === 0) return res.json([])

    const since = new Date(Date.now() - 30 * 864e5).toISOString()
    const { data, error } = await supabase
      .from('yt_videos')
      .select('*')
      .in('channel_id', ids)
      .gte('published_at', since)
      .gte('score', 0)
      .order('published_at', { ascending: false })
      .limit(80)
    if (error) throw error
    res.json(data ?? [])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const s = await readSettings()
    const { data: chans } = await supabase
      .from('yt_watches').select('value, label').eq('type', 'channel').order('label')
    res.json({ ...s, channels: chans ?? [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/settings/trending', requireAuth, async (req, res) => {
  try {
    const { on } = req.body ?? {}
    if (on) {
      const { error } = await supabase
        .from('yt_watches')
        .insert({ type: 'setting', value: 'trending_on', label: '급상승 수집', active: true })
      if (error) throw error
    } else {
      const { error } = await supabase
        .from('yt_watches').delete().eq('type', 'setting').eq('value', 'trending_on')
      if (error) throw error
    }
    res.json(await readSettings())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/radar', requireAuth, async (req, res) => {
  try {
    const { data: videos, error } = await supabase
      .from('yt_videos')
      .select('*')
      .gte('score', 30)
      .order('score', { ascending: false })
      .order('first_seen_at', { ascending: false })
      .limit(60)
    if (error) throw error
    if (!videos?.length) return res.json([])

    const { data: kws } = await supabase
      .from('yt_watches').select('value').eq('type', 'include_kw').eq('active', true)
    const includeKws = (kws ?? []).map((k) => k.value)

    const { data: snaps } = await supabase
      .from('yt_snapshots')
      .select('video_id, views, captured_at')
      .in('video_id', videos.map((v) => v.video_id))
      .order('captured_at', { ascending: false })

    const latest = {}
    for (const s of snaps ?? []) if (!(s.video_id in latest)) latest[s.video_id] = s.views

    res.json(videos.map((v) => ({
      ...v,
      views: latest[v.video_id] ?? 0,
      hits: matchedKeywords(v.title, includeKws)
    })))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/tracking', requireAuth, async (req, res) => {
  try {
    res.json(await buildTracking())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/watches', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('yt_watches').select('*').order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ watches: data ?? [], lastRun })
})

app.post('/api/watches', requireAuth, async (req, res) => {
  try {
    const { type, value, label } = req.body ?? {}
    const TYPES = ['keyword', 'channel', 'include_kw', 'exclude_kw', 'category', 'setting']
    if (!TYPES.includes(type) || !value?.trim()) {
      return res.status(400).json({ error: '입력을 확인해 주세요' })
    }

    let stored = value.trim()
    if (type === 'channel') {
      stored = await resolveChannelId(stored)
      if (!stored) return res.status(400).json({ error: '채널 ID를 찾지 못했어요' })
    }

    const { data, error } = await supabase
      .from('yt_watches')
      .insert({ type, value: stored, label: label?.trim() || value.trim(), active: true })
      .select()
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/watches/:id/toggle', requireAuth, async (req, res) => {
  try {
    const { data: cur, error: gErr } = await supabase
      .from('yt_watches').select('active').eq('id', req.params.id).single()
    if (gErr) throw gErr

    const { data, error } = await supabase
      .from('yt_watches').update({ active: !cur.active }).eq('id', req.params.id).select().single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/watches/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('yt_watches').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

app.post('/api/collect', requireAuth, async (req, res) => {
  try {
    res.json(await collect())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.use(express.static(path.join(__dirname, 'public')))

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`)

  // 시작 시 1회, 이후 3시간마다
  collect().catch((err) => console.error('[collect] 초기 실행 실패:', err.message))
  cron.schedule('0 */3 * * *', () => {
    collect().catch((err) => console.error('[collect] 예약 실행 실패:', err.message))
  })
})
