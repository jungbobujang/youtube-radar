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

// ---------------------------------------------------------------- 수집

let lastRun = null

async function collect() {
  const started = Date.now()
  const report = { trending: 0, watches: 0, videos: 0, errors: [] }
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

  // a. 인기 급상승 — videos.list 는 통계까지 함께 온다 (1 유닛)
  try {
    const data = await ytGet('videos', {
      part: 'snippet,statistics',
      chart: 'mostPopular',
      regionCode: 'KR',
      maxResults: 50
    })
    report.trending = await saveVideos(data.items ?? [], 'trending', cfg)
  } catch (err) {
    console.error('[collect] 인기 급상승 실패:', err.message)
    report.errors.push(`인기 급상승: ${err.message}`)
  }

  const since = new Date(Date.now() - 14 * 864e5).toISOString()

  for (const w of watches) {
    if (w.type !== 'keyword' && w.type !== 'channel') continue // 나머지는 채점용 설정
    // 한 감시 대상이 실패해도 나머지는 계속한다
    try {
      const params = {
        part: 'snippet',
        type: 'video',
        maxResults: 25
      }
      if (w.type === 'keyword') {
        params.q = w.value
        params.order = 'viewCount'
        params.publishedAfter = since
      } else if (w.type === 'channel') {
        params.channelId = w.value
        params.order = 'date'
      } else {
        continue
      }

      const found = await ytGet('search', params) // search.list = 100 유닛
      const ids = (found.items ?? []).map((i) => i.id?.videoId).filter(Boolean)
      if (ids.length === 0) continue

      const details = await fetchVideoDetails(ids)
      report.videos += await saveVideos(details, `${w.type}:${w.value}`, cfg)
      report.watches++
    } catch (err) {
      console.error(`[collect] 감시 "${w.label || w.value}" 실패:`, err.message)
      report.errors.push(`${w.label || w.value}: ${err.message}`)
    }
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
    const TYPES = ['keyword', 'channel', 'include_kw', 'exclude_kw', 'category']
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
