const fs = require('fs')
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

// ---------------------------------------------------------------- 실패 로그
//
// 실패는 DB 가 아니라 로컬 파일에 남긴다. 수집 실패까지 DB 에 쓰면
// DB 가 흔들릴 때 로그도 같이 사라진다. 하루 한 파일, 한 줄 JSON.
const LOG_DIR = path.join(__dirname, 'logs')

function logFailure(scope, err) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    scope,
    status: err?.status ?? null,
    reason: err?.reason ?? null,
    message: err?.message ?? String(err)
  })
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(
      path.join(LOG_DIR, `collect-${new Date().toISOString().slice(0, 10)}.log`),
      `${line}\n`
    )
  } catch (e) {
    // 로그를 못 남긴다고 수집을 멈추지는 않는다
    console.warn(`[log] 실패 로그 기록 실패: ${e.message}`)
  }
}

// ---------------------------------------------------------------- 할당량 장부
//
// 오늘 쓴 유닛을 파일에 적어 둔다. DB 를 건드리지 않고, 재시작해도 남는다.
// 할당량 리셋은 태평양 자정 기준이라 파일 이름도 그 날짜로 끊는다.
const QUOTA_LIMIT = 10000

function quotaDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
}

function unitsFile(date = quotaDate()) {
  return path.join(LOG_DIR, `units-${date}.json`)
}

function readUnitsToday() {
  try {
    return Number(JSON.parse(fs.readFileSync(unitsFile(), 'utf8')).units) || 0
  } catch {
    return 0 // 오늘 첫 수집이면 파일이 없다
  }
}

function addUnitsToday(n) {
  if (!n) return
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const date = quotaDate()
    fs.writeFileSync(
      unitsFile(date),
      JSON.stringify({ date, units: readUnitsToday() + Number(n) })
    )
  } catch (e) {
    console.warn(`[quota] 사용량 기록 실패: ${e.message}`)
  }
}

// ---------------------------------------------------------------- YouTube API

const YT_BASE = 'https://www.googleapis.com/youtube/v3'

class YtError extends Error {
  constructor(message, status, reason) {
    super(message)
    this.name = 'YtError'
    this.status = status
    this.reason = reason
  }
}

// 할당량이 바닥나면 이번 사이클은 무엇을 더 불러도 같은 답이 온다.
// 재시도로 시간을 버리지 말고 사이클을 접은 뒤 다음 cron 에서 정상 복귀한다.
const QUOTA_REASONS = new Set([
  'quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'
])

function isQuotaError(err) {
  if (!err) return false
  if (err.reason && QUOTA_REASONS.has(err.reason)) return true
  if (err.status === 429) return true
  return err.status === 403 && /quota/i.test(err.message ?? '')
}

// 5xx 와 네트워크 오류만 다시 걸어 본다. 4xx(키 오류·잘못된 요청)는 다시 걸어도 같다.
function isTransient(err) {
  if (isQuotaError(err)) return false
  if (!(err instanceof YtError)) return true
  return err.status >= 500
}

const RETRY = { tries: 3, baseMs: 800 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ytGet(endpoint, params) {
  const url = new URL(`${YT_BASE}/${endpoint}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  }
  url.searchParams.set('key', YT_API_KEY)

  let lastErr
  for (let attempt = 1; attempt <= RETRY.tries; attempt++) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()

      const body = await res.text()
      let reason = null
      try {
        reason = JSON.parse(body)?.error?.errors?.[0]?.reason ?? null
      } catch { /* 본문이 JSON 이 아닐 수도 있다 */ }
      lastErr = new YtError(
        `${endpoint} ${res.status}${reason ? ` (${reason})` : ''}: ${body.slice(0, 300)}`,
        res.status,
        reason
      )
    } catch (err) {
      lastErr = err // fetch 자체가 실패(네트워크·DNS·타임아웃)
    }

    if (!isTransient(lastErr)) throw lastErr
    if (attempt < RETRY.tries) {
      console.warn(`[yt] ${endpoint} ${attempt}차 실패, 재시도: ${lastErr.message}`)
      await sleep(RETRY.baseMs * attempt)
    }
  }
  throw lastErr
}

// videos.list 는 한 번에 50개까지. id 를 나눠 던진다.
// contentDetails 를 붙여도 유닛은 그대로 1이다.
async function fetchVideoDetails(ids) {
  const out = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const data = await ytGet('videos', {
      part: 'snippet,statistics,contentDetails',
      id: chunk.join(',')
    })
    out.push(...(data.items ?? []))
  }
  return out
}

// ISO 8601 (PT1H2M3S) -> 초
function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso ?? '')
  if (!m) return null
  return Math.round(
    (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) +
    (Number(m[3] || 0) * 60) + Number(m[4] || 0)
  )
}

const FORMAT_BOUNDS = { SHORTS: 60, MID: 180 }

function videoFormat(sec) {
  if (sec == null) return 'unknown'
  if (sec <= FORMAT_BOUNDS.SHORTS) return 'shorts'
  if (sec <= FORMAT_BOUNDS.MID) return 'mid'
  return 'long'
}

// 채널 단위 오버라이드가 있으면 재생시간을 무시하고 그 값을 쓴다.
// 1분짜리를 정규 콘텐츠로 올리는 채널처럼, 길이로는 갈리지 않는 경우가 있다.
function effectiveFormat(video, overrides) {
  const ov = overrides?.get(video.channel_id)
  return ov || videoFormat(video.duration_sec)
}

// 채널 id -> format_override
async function formatOverrides() {
  const { data, error } = await supabase
    .from('yt_watches').select('value, format_override').eq('type', 'channel')
  if (error) return new Map() // 컬럼이 아직 없으면 오버라이드 없이 동작
  return new Map((data ?? [])
    .filter((w) => w.format_override)
    .map((w) => [w.value, w.format_override]))
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

async function saveVideos(items, source, cfg, opts = {}) {
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
    duration_sec: parseDuration(v.contentDetails?.duration),
    score: scoreVideo(v, cfg, source),
    source
  }))

  // PostgREST 의 upsert 는 페이로드에 없는 컬럼을 기본값으로 되돌린다.
  // 그대로 쓰면 수집이 돌 때마다 starred/starred_at/multiple 이 날아간다.
  // 갱신할 컬럼을 명시한 DB 함수로 넘긴다.
  const { error: vErr } = await supabase.rpc('upsert_videos', { payload: videoRows })
  if (vErr) throw vErr

  // 재생시간 백필처럼 통계를 다시 읽는 목적이 아닌 호출은 스냅샷을 남기지 않는다
  if (opts.snapshot !== false) {
    const snapRows = items.map((v) => ({
      video_id: v.id,
      views: Number(v.statistics?.viewCount ?? 0),
      likes: Number(v.statistics?.likeCount ?? 0),
      comments: Number(v.statistics?.commentCount ?? 0)
    }))

    const { error: sErr } = await supabase.from('yt_snapshots').insert(snapRows)
    if (sErr) throw sErr
  }

  return items.length
}

// ---------------------------------------------------------------- 발굴 지표
//
// 발굴점수 = log(1+배율) × log(1+침투력) × (1 + 참여율/ENGAGE_DIVISOR)
//
// 곱셈 그대로 쓰면 배율과 침투력이 같은 방향으로 커지는 채널(구독자 대비 조회수가
// 폭발하는 쇼츠 채널)에서 점수가 제곱으로 튀어 한 채널이 목록을 독점한다.
// 로그로 완충한다. 상수는 여기서 조정한다.
const METRIC = {
  ENGAGE_DIVISOR: 5,      // 참여율이 점수에 기여하는 정도 (클수록 영향 작아짐)
  PER_CHANNEL_CAP: 3,     // 발굴 목록에서 한 채널이 차지할 수 있는 최대 개수
  COMMENT_WEIGHT: 3,      // 댓글 1개를 좋아요 몇 개로 볼지
  DEAD_CHANNEL: 0.05,     // 채널활력이 이 아래면 ⚠️ (죽은 채널의 과거 영광)
  HOT_ENGAGE_PCTL: 0.75,  // 참여율 상위 25% 에 💬 진한반응
  CHANNEL_TTL_H: 24,      // 구독자 수 갱신 주기(시간)
  MEDIAN_WINDOW_D: 90,    // 채널활력용 최근 N일
  DEBATE_RATIO: 0.15,     // 댓글/좋아요가 이 위면 🗣️ 토론형
  VELOCITY_WINDOW_D: 7,   // 에버그린 최근 증가량 창(일)
  SATURATION_WINDOW_D: 90,// 주제 포화도를 볼 최근 N일
  SATURATION_WARN: 2,     // 다른 채널 이만큼부터 ⚠️ 재탕 경고
  WEEKLY_TOP: 10,         // 주간 리포트 신작 상위 개수
  WEEKLY_DIG_MIN: 5,      // 주간 리포트에 올릴 최소 배율
  WEEKLY_DIG_MAX: 20      // 주간 리포트 발굴분 최대 개수
}

function deriveMetrics(v, channel) {
  const views = Number(v.views ?? 0)
  const likes = Number(v.like_count ?? 0)
  const comments = Number(v.comment_count ?? 0)
  const subs = Number(channel?.subscriber_count ?? 0)
  const recentMedian = Number(channel?.recent_median_views ?? 0)

  const reach = subs > 0 ? views / subs : null                 // 침투력
  const engage = views > 0
    ? ((likes + comments * METRIC.COMMENT_WEIGHT) / views) * 100
    : 0                                                        // 참여율 %
  const vitality = subs > 0 ? recentMedian / subs : null       // 채널활력
  const multiple = Number(v.multiple ?? 0)

  // 토론성 — 좋아요 대비 댓글. 참여율(💬 진한반응)과는 다른 축이다.
  // 참여율은 "반응이 많은가", 토론성은 "그 반응이 말로 나오는가" 를 본다.
  // 좋아요가 0 이면 대개 표시가 꺼진 영상이라 비율을 내지 않는다.
  const debate = likes > 0 ? comments / likes : null

  // 구독자 수를 아직 모르면 침투력을 1로 두어 배율·참여율만으로 점수를 낸다
  const digScore =
    Math.log(1 + Math.max(multiple, 0)) *
    Math.log(1 + Math.max(reach ?? 1, 0)) *
    (1 + engage / METRIC.ENGAGE_DIVISOR)

  return {
    reach: reach == null ? null : Number(reach.toFixed(2)),
    engage: Number(engage.toFixed(2)),
    vitality: vitality == null ? null : Number(vitality.toFixed(4)),
    dig_score: Number(digScore.toFixed(2)),
    dead_channel: vitality != null && vitality < METRIC.DEAD_CHANNEL,
    debate_ratio: debate == null ? null : Number(debate.toFixed(3)),
    debate: debate != null && debate >= METRIC.DEBATE_RATIO
  }
}

// ---------------------------------------------------------------- 지표 등급
//
// 절대 기준(배율 3배 이상은 좋음 같은 식)은 채널 성격에 따라 쉽게 무의미해진다.
// 지금 보고 있는 목록의 분포로 줄 세운다 — 상위 25% great, 하위 25% low, 나머지 normal.
const GRADE_MIN_SAMPLE = 8 // 표본이 이보다 적으면 사분위가 의미 없어 등급을 매기지 않는다

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

function gradeBy(rows, get) {
  const vals = rows.map(get).filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b)
  if (vals.length < GRADE_MIN_SAMPLE) return () => null

  const p25 = quantile(vals, 0.25)
  const p75 = quantile(vals, 0.75)
  return (n) => {
    if (n == null || !Number.isFinite(n)) return null
    if (n >= p75) return 'great'
    if (n <= p25) return 'low'
    return 'normal'
  }
}

// 세 지표는 축이 다르므로 각자의 분포로 따로 줄 세운다
function attachGrades(rows) {
  const num = (n) => (n == null ? null : Number(n))
  const g = {
    multiple: gradeBy(rows, (v) => num(v.multiple)),
    reach: gradeBy(rows, (v) => num(v.reach)),
    engage: gradeBy(rows, (v) => num(v.engage))
  }
  for (const v of rows) {
    v.grade = {
      multiple: g.multiple(num(v.multiple)),
      reach: g.reach(num(v.reach)),
      engage: g.engage(num(v.engage))
    }
  }
  return rows
}

// ---------------------------------------------------------------- 에버그린

// 일평균 조회수 + 스냅샷 기반 최근 N일 증가량.
//
// 스냅샷을 PostgREST 로 긁어오면 안 된다. 후보 수백 건 × 영상당 스냅샷 수십 행이면
// 기본 1000행 상한에 조용히 잘려 증가량이 틀린다. DB 함수 한 번으로 끝낸다.
async function velocityMap(ids) {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase.rpc('video_velocity', {
    ids, window_days: METRIC.VELOCITY_WINDOW_D
  })
  if (error) {
    console.warn(`[metric] 최근 속도 계산 실패(함수 없음?): ${error.message}`)
    return new Map()
  }
  return new Map((data ?? []).map((r) => [r.video_id, r]))
}

// 스냅샷이 2개 미만이면 증가량을 못 낸다 ('측정 중'). 일평균은 스냅샷 없이도 나온다.
function attachEvergreen(rows, vel) {
  for (const v of rows) {
    const days = v.published_at
      ? Math.max((Date.now() - new Date(v.published_at)) / DAY, 1)
      : null
    v.avg_daily_views = days == null ? null : Math.round(Number(v.views ?? 0) / days)

    const r = vel.get(v.video_id)
    const measured = r && Number(r.snaps ?? 0) >= 2 && r.prev_views != null
    v.velocity_pending = !measured
    v.recent_delta = measured ? Number(r.latest_views) - Number(r.prev_views) : null
  }
  return rows
}

// ---------------------------------------------------------------- 주제 포화도

// 이 영상의 핵심어를 다른 채널이 최근에 몇 곳이나 다뤘는지.
// 영상마다 ilike 를 따로 던지면 80건에 80왕복이라, 핵심어를 묶어 DB 함수로 넘긴다.
async function saturationMap(rows) {
  const payload = rows
    .map((v) => ({
      video_id: v.video_id,
      channel_id: v.channel_id,
      keyword: extractKeywords(v.title)[0] ?? ''
    }))
    .filter((x) => x.keyword.length >= 2)
  if (payload.length === 0) return new Map()

  const { data, error } = await supabase.rpc('topic_saturation', {
    payload, window_days: METRIC.SATURATION_WINDOW_D
  })
  if (error) {
    console.warn(`[metric] 주제 포화도 계산 실패(함수 없음?): ${error.message}`)
    return new Map()
  }
  return new Map((data ?? []).map((r) => [r.video_id, Number(r.channels ?? 0)]))
}

// 핵심어를 못 뽑았거나 함수가 없으면 null 로 두어 화면에서 아무것도 그리지 않는다
async function attachSaturation(rows) {
  const sat = await saturationMap(rows)
  for (const v of rows) {
    const n = sat.get(v.video_id)
    v.saturation = n == null ? null : n
  }
  return rows
}

// 구독자 수와 최근 90일 조회수 중앙값. 하루 1회만 갱신한다 (channels.list = 1유닛/50개)
async function refreshChannels(force = false) {
  const { data: watches } = await supabase
    .from('yt_watches').select('value, label').eq('type', 'channel')
  const ids = (watches ?? []).map((w) => w.value)
  if (ids.length === 0) return { updated: 0, units: 0 }

  const { data: existing } = await supabase.from('yt_channels').select('*')
  const known = new Map((existing ?? []).map((c) => [c.channel_id, c]))

  const cutoff = Date.now() - METRIC.CHANNEL_TTL_H * 3600e3
  const stale = ids.filter((id) => {
    const c = known.get(id)
    return force || !c || !c.updated_at || new Date(c.updated_at).getTime() < cutoff
  })
  if (stale.length === 0) return { updated: 0, units: 0 }

  let units = 0
  const rows = []

  for (let i = 0; i < stale.length; i += 50) {
    const chunk = stale.slice(i, i + 50)
    const data = await ytGet('channels', { part: 'snippet,statistics', id: chunk.join(',') })
    units += 1
    for (const c of data.items ?? []) {
      rows.push({
        channel_id: c.id,
        title: c.snippet?.title ?? null,
        subscriber_count: Number(c.statistics?.subscriberCount ?? 0),
        recent_median_views: 0,
        updated_at: new Date().toISOString()
      })
    }
  }

  // 최근 N일 영상 조회수의 중앙값
  const since = new Date(Date.now() - METRIC.MEDIAN_WINDOW_D * 864e5).toISOString()
  for (const row of rows) {
    const { data: vids } = await supabase
      .from('yt_videos').select('views')
      .eq('channel_id', row.channel_id)
      .gte('published_at', since)
      .limit(1000)
    const arr = (vids ?? []).map((r) => Number(r.views ?? 0)).sort((a, b) => a - b)
    if (arr.length > 0) {
      const mid = Math.floor(arr.length / 2)
      row.recent_median_views = Math.round(
        arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2
      )
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase.from('yt_channels').upsert(rows, { onConflict: 'channel_id' })
    if (error) throw error
  }
  return { updated: rows.length, units }
}

async function channelMap() {
  const { data } = await supabase.from('yt_channels').select('*')
  return new Map((data ?? []).map((c) => [c.channel_id, c]))
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

const DURATION_UNIT_BUDGET = 20 // 1회 수집에서 재생시간 백필에 쓸 유닛 (50개당 1유닛)

// 기존 수집분은 duration_sec 이 없다. 매 수집마다 예산만큼 채워 넣는다.
async function backfillDurations(cfg) {
  let used = 0
  let filled = 0

  while (used < DURATION_UNIT_BUDGET) {
    const { data, error } = await supabase
      .from('yt_videos')
      .select('video_id')
      .is('duration_sec', null)
      .limit(50)
    if (error) throw error
    if (!data || data.length === 0) break

    const details = await fetchVideoDetails(data.map((r) => r.video_id))
    used += 1
    if (details.length === 0) break

    filled += await saveVideos(details, 'duration-backfill', cfg, { snapshot: false })
    if (data.length < 50) break
  }
  return { used, filled }
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
let collecting = false

// 실패는 한 곳에서 기록한다 (콘솔 + 화면용 report + logs/ 파일).
// 할당량 문제면 true 를 돌려주고, 부르는 쪽은 이번 사이클을 접는다.
function noteError(report, scope, err) {
  const msg = err?.message ?? String(err)
  console.error(`[collect] ${scope} 실패:`, msg)
  report.errors.push(`${scope}: ${msg}`)
  logFailure(scope, err)

  if (isQuotaError(err)) {
    report.aborted = 'quota'
    console.warn('[collect] 할당량 초과 — 이번 사이클은 접고 다음 주기에 다시 시도합니다')
    return true
  }
  return false
}

async function readSettings() {
  const { data } = await supabase
    .from('yt_watches').select('value').eq('type', 'setting').eq('active', true)
  const flags = new Set((data ?? []).map((r) => r.value))
  return { trendingOn: flags.has('trending_on') } // 기본 off
}

// 한 단계가 실패해도 다음 단계는 계속한다.
// 다만 할당량이 바닥나면 뒤 단계도 전부 같은 오류를 받을 뿐이라 그 자리에서 접는다.
async function runCycle(report) {
  // 채점에 쓸 설정을 먼저 읽는다 (급상승 카테고리 필터가 여기 달려 있다)
  let watches = []
  try {
    const { data, error } = await supabase
      .from('yt_watches').select('*').eq('active', true)
    if (error) throw error
    watches = data ?? []
  } catch (err) {
    noteError(report, '감시 목록', err)
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
      if (noteError(report, '인기 급상승', err)) return
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
      if (noteError(report, `감시 ${w.label || w.value}`, err)) return
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
          if (noteError(report, `백카탈로그 ${watch.label || watch.value}`, err)) return
        }
      }
    } catch (err) {
      if (noteError(report, '백카탈로그', err)) return
    }
  }

  // c-2. 재생시간이 비어 있는 과거 영상 채우기
  try {
    const r = await backfillDurations(cfg)
    report.durations = r.filled
    report.units += r.used
  } catch (err) {
    if (noteError(report, '재생시간 백필', err)) return
  }

  // d. 채널 정보(구독자·최근 중앙값) — 하루 1회
  try {
    const r = await refreshChannels()
    report.channels = r.updated
    report.units += r.units
  } catch (err) {
    if (noteError(report, '채널 정보', err)) return
  }

  // e. 채널별 중앙값 대비 배율 갱신
  try {
    report.multiples = await recomputeMultiples()
  } catch (err) {
    noteError(report, '배율', err)
  }
}

// 수동 수집과 cron 이 겹치면 같은 일을 두 번 하며 할당량만 태운다. 한 번에 하나만 돈다.
async function collect() {
  if (collecting) {
    console.warn('[collect] 이미 실행 중입니다. 이번 호출은 건너뜁니다')
    return lastRun
  }
  collecting = true

  const started = Date.now()
  const report = { trending: 0, watches: 0, videos: 0, byWatch: {}, units: 0, errors: [] }
  console.log('[collect] 시작')

  try {
    await runCycle(report)
  } catch (err) {
    // 예상 못 한 오류까지 여기서 삼킨다. 사이클만 접히고 서버와 cron 은 그대로 산다.
    noteError(report, '수집', err)
  } finally {
    collecting = false
  }

  addUnitsToday(report.units)

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
    addUnitsToday(1)
    if (data.items?.[0]?.id) return data.items[0].id
  }

  // /c/이름, /user/이름 같은 옛 형태는 검색으로 (100 유닛)
  const name = raw.replace(/^https?:\/\/[^/]+\//, '').replace(/^(c|user)\//, '').split(/[/?]/)[0]
  if (name) {
    const data = await ytGet('search', { part: 'snippet', type: 'channel', q: name, maxResults: 1 })
    addUnitsToday(100)
    if (data.items?.[0]?.id?.channelId) return data.items[0].id.channelId
  }
  return null
}

// ---------------------------------------------------------------- 키워드 추출

// 제목에서 검색에 쓸 만한 핵심어를 뽑는다. 형태소 분석기 없이 조사/불용어만 걷어낸다.
const PARTICLES = /(은|는|이|가|을|를|의|에|에서|에게|으로|로|와|과|도|만|까지|부터|보다|처럼|라고|이라고|한테|께서|이나|나|든지|조차|마저)$/
const STOPWORDS = new Set([
  '그', '이', '저', '것', '수', '등', '및', '더', '왜', '어떻게', '무엇', '정말', '진짜',
  '가장', '너무', '아주', '다시', '지금', '오늘', '우리', '당신', '사람', '이유', '방법',
  '영상', '공식', '풀버전', '하이라이트', '레전드', '모음', 'shorts', 'the', 'a', 'of', 'to'
])

function extractKeywords(title) {
  const cleaned = String(title ?? '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ') // 이모지
    .replace(/[[\]()（）{}<>|·・…"'"'`~!?.,:;#@*/\\_+=-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const words = cleaned.split(' ')
    .map((w) => w.replace(PARTICLES, ''))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w.toLowerCase()) && !/^\d+$/.test(w))

  if (words.length === 0) return []

  // 2어절 명사구를 우선 후보로, 그다음 단어 단위
  const phrases = []
  for (let i = 0; i < words.length - 1; i++) phrases.push(`${words[i]} ${words[i + 1]}`)

  return [...new Set([...phrases.slice(0, 3), ...words.slice(0, 5)])]
}

async function relatedFromDb(keyword, excludeId) {
  const term = String(keyword ?? '').trim()
  if (!term) return []

  const { data, error } = await supabase
    .from('yt_videos')
    .select('*')
    .ilike('title', `%${term}%`)
    .gte('score', 0)
    .limit(200)
  if (error) throw error

  const chans = await channelMap()
  return (data ?? [])
    .filter((v) => v.video_id !== excludeId)
    .map((v) => ({ ...v, ...deriveMetrics(v, chans.get(v.channel_id)) }))
    .sort((a, b) => b.dig_score - a.dig_score)
    .slice(0, 10)
}

// ---------------------------------------------------------------- 그룹

// 그룹 id -> 그 그룹에 속한 채널 id 목록
async function groupChannelIds(groupId) {
  const { data: links } = await supabase
    .from('yt_watch_groups').select('watch_id').eq('group_id', groupId)
  const watchIds = (links ?? []).map((r) => r.watch_id)
  if (watchIds.length === 0) return []

  const { data: watches } = await supabase
    .from('yt_watches').select('value').in('id', watchIds).eq('type', 'channel')
  return (watches ?? []).map((w) => w.value)
}

const SUB_RANGES = {
  small: [0, 50000],
  mid: [50000, 300000],
  large: [300000, Number.MAX_SAFE_INTEGER]
}

function passesSubFilter(v, chans, key) {
  const range = SUB_RANGES[key]
  if (!range) return true
  const subs = Number(chans.get(v.channel_id)?.subscriber_count ?? 0)
  return subs >= range[0] && subs < range[1]
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

    // 정렬 기준이 계산값이라 후보를 넉넉히 받아 서버에서 줄 세운다
    const { group = 'all', subs = 'all', format = 'long' } = req.query

    let q = supabase
      .from('yt_videos')
      .select('*')
      .gte('multiple', Number(min) || 3)
      .gte('published_at', oldest)
      .lte('published_at', newest)
      .gte('score', 0)
      .order('multiple', { ascending: false })
      .limit(600)
    if (channel !== 'all') q = q.eq('channel_id', channel)
    if (group !== 'all') {
      const ids = await groupChannelIds(group)
      if (ids.length === 0) return res.json([])
      q = q.in('channel_id', ids)
    }

    const { data, error } = await q
    if (error) throw error

    const chans = await channelMap()
    const overrides = await formatOverrides()
    const rows = (data ?? [])
      .filter((v) => passesSubFilter(v, chans, subs))
      .map((v) => ({ ...v, format: effectiveFormat(v, overrides) }))
      .filter((v) => format === 'all' || v.format === format)
      .map((v) => ({ ...v, ...deriveMetrics(v, chans.get(v.channel_id)) }))

    // 참여율 상위 25% 를 진한반응으로 표시
    const engages = rows.map((r) => r.engage).sort((a, b) => a - b)
    const cut = engages.length
      ? engages[Math.floor((engages.length - 1) * METRIC.HOT_ENGAGE_PCTL)]
      : Infinity
    for (const r of rows) r.hot_engage = r.engage >= cut && r.engage > 0

    // 등급은 잘라내기 전 후보 전체의 분포로 매긴다 (화면 80건만 보면 분포가 좁아진다)
    attachGrades(rows)

    // 정렬 기준이 될 수 있으므로 줄 세우기 전에 붙인다
    attachEvergreen(rows, await velocityMap(rows.map((v) => v.video_id)))

    const SORTS = {
      dig: (a, b) => b.dig_score - a.dig_score,
      reach: (a, b) => (b.reach ?? -1) - (a.reach ?? -1),
      engage: (a, b) => b.engage - a.engage,
      multiple: (a, b) => (b.multiple ?? 0) - (a.multiple ?? 0),
      velocity: (a, b) => (b.recent_delta ?? -1) - (a.recent_delta ?? -1)
    }
    rows.sort(SORTS[req.query.sort] ?? SORTS.dig)

    // 한 채널이 목록을 독점하지 않게 상한을 둔다.
    // 특정 채널을 지정해 보는 중이라면 상한은 의미가 없으므로 푼다.
    let out = rows
    if (channel === 'all') {
      const seen = {}
      out = rows.filter((v) => {
        const n = (seen[v.channel_id] = (seen[v.channel_id] ?? 0) + 1)
        return n <= METRIC.PER_CHANNEL_CAP
      })
    }

    // 포화도는 화면에 나갈 것만 본다 (제목 ilike 라 후보 전체에 돌리면 비싸다)
    res.json(await attachSaturation(out.slice(0, 80)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 📡 신작 — 감시 채널의 최근 30일 영상
app.get('/api/fresh', requireAuth, async (req, res) => {
  try {
    const { group = 'all', channel = 'all', subs = 'all', format = 'long' } = req.query

    let ids
    if (group !== 'all') {
      ids = await groupChannelIds(group)
    } else {
      const { data: chans } = await supabase
        .from('yt_watches').select('value').eq('type', 'channel')
      ids = (chans ?? []).map((c) => c.value)
    }
    if (channel !== 'all') ids = ids.filter((id) => id === channel)
    if (ids.length === 0) return res.json([])

    const since = new Date(Date.now() - 30 * 864e5).toISOString()
    const { data, error } = await supabase
      .from('yt_videos')
      .select('*')
      .in('channel_id', ids)
      .gte('published_at', since)
      .gte('score', 0)
      .order('published_at', { ascending: false })
      .limit(300)
    if (error) throw error

    const chans = await channelMap()
    const overrides = await formatOverrides()
    const all = (data ?? [])
      .filter((v) => passesSubFilter(v, chans, subs))
      .map((v) => ({ ...v, format: effectiveFormat(v, overrides) }))
      .filter((v) => format === 'all' || v.format === format)
      .map((v) => ({ ...v, ...deriveMetrics(v, chans.get(v.channel_id)) }))

    // 등급은 잘라내기 전 전체 분포로 매긴다
    const rows = attachGrades(all).slice(0, 80)

    attachEvergreen(rows, await velocityMap(rows.map((v) => v.video_id)))
    res.json(await attachSaturation(rows))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const s = await readSettings()
    const { data: chans } = await supabase
      .from('yt_watches').select('value, label').eq('type', 'channel').order('label')
    const { data: groups } = await supabase
      .from('yt_groups').select('*').order('position', { ascending: true })
    res.json({ ...s, channels: chans ?? [], groups: groups ?? [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ---- 그룹 CRUD

app.get('/api/groups', requireAuth, async (req, res) => {
  try {
    const { data: groups, error } = await supabase
      .from('yt_groups').select('*').order('position', { ascending: true })
    if (error) throw error
    const { data: links } = await supabase.from('yt_watch_groups').select('*')
    res.json({ groups: groups ?? [], links: links ?? [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/groups', requireAuth, async (req, res) => {
  try {
    const { name, icon } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ error: '이름이 필요해요' })
    const { data: cur } = await supabase.from('yt_groups').select('position')
    const position = (cur ?? []).reduce((m, g) => Math.max(m, g.position ?? 0), 0) + 1
    const { data, error } = await supabase
      .from('yt_groups')
      .insert({ name: name.trim(), icon: icon || '📁', position })
      .select().single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.patch('/api/groups/:id', requireAuth, async (req, res) => {
  try {
    const patch = {}
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim()
    if (req.body?.icon !== undefined) patch.icon = req.body.icon
    const { data, error } = await supabase
      .from('yt_groups').update(patch).eq('id', req.params.id).select().single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 그룹을 지워도 채널은 남는다. 연결만 끊긴다 (on delete cascade).
app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('yt_groups').delete().eq('id', req.params.id)
    if (error) throw error
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/watch-groups', requireAuth, async (req, res) => {
  try {
    const { watch_id, group_id, on } = req.body ?? {}
    if (!watch_id || !group_id) return res.status(400).json({ error: '입력을 확인해 주세요' })
    if (on) {
      const { error } = await supabase
        .from('yt_watch_groups').upsert({ watch_id, group_id }, { onConflict: 'watch_id,group_id' })
      if (error) throw error
    } else {
      const { error } = await supabase
        .from('yt_watch_groups').delete().eq('watch_id', watch_id).eq('group_id', group_id)
      if (error) throw error
    }
    res.json({ ok: true })
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

// ⭐ 즐겨찾기
app.post('/api/star', requireAuth, async (req, res) => {
  try {
    const { video_id, starred } = req.body ?? {}
    if (!video_id) return res.status(400).json({ error: 'video_id 가 필요해요' })
    const { error } = await supabase
      .from('yt_videos')
      .update({ starred: !!starred, starred_at: starred ? new Date().toISOString() : null })
      .eq('video_id', video_id)
    if (error) throw error
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/starred', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('yt_videos')
      .select('*')
      .eq('starred', true)
      .order('starred_at', { ascending: false })
      .limit(200)
    if (error) throw error
    const chans = await channelMap()
    const rows = (data ?? []).map((v) => ({ ...v, ...deriveMetrics(v, chans.get(v.channel_id)) }))

    attachEvergreen(rows, await velocityMap(rows.map((v) => v.video_id)))
    res.json(await attachSaturation(rows))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------- 주간 리포트
//
// 지난 7일을 한 장으로 요약한다. 이미 쌓인 DB 만 읽으므로 할당량을 쓰지 않는다.
// cron 에는 걸지 않는다 — 탭을 열 때만 계산한다.
async function weeklyReport() {
  const since = new Date(Date.now() - 7 * DAY).toISOString()

  const chans = await channelMap()
  const overrides = await formatOverrides()
  const decorate = (v) => ({
    ...v,
    format: effectiveFormat(v, overrides),
    ...deriveMetrics(v, chans.get(v.channel_id))
  })

  // a. 지난 7일 신작 중 성과 상위 — 배율 우선, 같으면 조회수
  const { data: watched } = await supabase
    .from('yt_watches').select('value').eq('type', 'channel')
  const channelIds = (watched ?? []).map((w) => w.value)

  let topFresh = []
  if (channelIds.length > 0) {
    const { data, error } = await supabase
      .from('yt_videos')
      .select('*')
      .in('channel_id', channelIds)
      .gte('published_at', since)
      .gte('score', 0)
      .order('views', { ascending: false })
      .limit(500)
    if (error) throw error
    topFresh = (data ?? [])
      .map(decorate)
      .sort((a, b) =>
        (b.multiple ?? 0) - (a.multiple ?? 0) || (b.views ?? 0) - (a.views ?? 0))
      .slice(0, METRIC.WEEKLY_TOP)
  }

  // b. 이번 주에 처음 눈에 띈 배율 5배 이상 — 백카탈로그에서 새로 올라온 것들.
  //    게시일이 아니라 first_seen_at 을 본다 (발굴은 과거 영상이 대상이라)
  const { data: digs, error: dErr } = await supabase
    .from('yt_videos')
    .select('*')
    .gte('first_seen_at', since)
    .gte('multiple', METRIC.WEEKLY_DIG_MIN)
    .gte('score', 0)
    .order('multiple', { ascending: false })
    .limit(200)
  if (dErr) throw dErr
  const newDigs = (digs ?? []).map(decorate).slice(0, METRIC.WEEKLY_DIG_MAX)

  // c. 즐겨찾기 — 전체와 이번 주 추가분
  const { count: starTotal } = await supabase
    .from('yt_videos').select('video_id', { count: 'exact', head: true }).eq('starred', true)
  const { count: starWeek } = await supabase
    .from('yt_videos').select('video_id', { count: 'exact', head: true })
    .eq('starred', true).gte('starred_at', since)

  return {
    generated_at: new Date().toISOString(),
    since,
    window_days: 7,
    top_fresh: topFresh,
    new_digs: newDigs,
    starred: { total: starTotal ?? 0, this_week: starWeek ?? 0 }
  }
}

// 📊 주간 — 수동 조회 전용 (cron 미등록)
app.get('/api/weekly', requireAuth, async (req, res) => {
  try {
    res.json(await weeklyReport())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 🔎 관련 주제 — DB 안에서만 찾는다 (할당량 0)
app.get('/api/related', requireAuth, async (req, res) => {
  try {
    const { video_id, q } = req.query
    let keywords = []
    let keyword = q

    if (video_id) {
      const { data } = await supabase
        .from('yt_videos').select('title').eq('video_id', video_id).single()
      keywords = extractKeywords(data?.title)
    }

    if (keyword) {
      return res.json({ keyword, keywords, results: await relatedFromDb(keyword, video_id) })
    }

    // 명사구를 먼저 시도하되, 조사를 뗀 구가 원문과 안 맞아 0건이면
    // 다음 후보로 넘어간다. 빈 패널이 뜨는 것보다 낫다.
    for (const cand of keywords) {
      const results = await relatedFromDb(cand, video_id)
      if (results.length > 0) return res.json({ keyword: cand, keywords, results })
    }
    res.json({ keyword: keywords[0] ?? '', keywords, results: [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 🔎 관련 주제 — 유튜브 전체 검색 (search.list = 100 유닛, 누를 때만)
app.post('/api/related/search', requireAuth, async (req, res) => {
  try {
    const { q, video_id } = req.body ?? {}
    const term = String(q ?? '').trim()
    if (!term) return res.status(400).json({ error: '키워드가 필요해요' })

    const found = await ytGet('search', {
      part: 'snippet', type: 'video', maxResults: 25, q: term, order: 'viewCount'
    })
    const ids = (found.items ?? []).map((i) => i.id?.videoId).filter(Boolean)

    let saved = 0
    if (ids.length > 0) {
      const watches = await supabase.from('yt_watches').select('*').eq('active', true)
      const rows = watches.data ?? []
      const cfg = {
        includeKws: rows.filter((w) => w.type === 'include_kw').map((w) => w.value),
        excludeKws: rows.filter((w) => w.type === 'exclude_kw').map((w) => w.value),
        categoryIds: rows.filter((w) => w.type === 'category').map((w) => String(w.value))
      }
      const details = await fetchVideoDetails(ids)
      saved = await saveVideos(details, `related:${term}`, cfg)
    }

    const units = 100 + Math.ceil(ids.length / 50)
    addUnitsToday(units)
    res.json({ keyword: term, saved, units, results: await relatedFromDb(term, video_id) })
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

app.patch('/api/watches/:id', requireAuth, async (req, res) => {
  try {
    const { format_override } = req.body ?? {}
    const allowed = [null, '', 'long', 'shorts']
    if (!allowed.includes(format_override)) {
      return res.status(400).json({ error: '형식 값을 확인해 주세요' })
    }
    const { data, error } = await supabase
      .from('yt_watches')
      .update({ format_override: format_override || null })
      .eq('id', req.params.id)
      .select().single()
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

// 상태바 — 마지막 수집·총 영상 수·오늘 쓴 할당량
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const { count } = await supabase
      .from('yt_videos').select('video_id', { count: 'exact', head: true })
    const units = readUnitsToday()
    res.json({
      collecting,
      last_run: lastRun && {
        at: lastRun.at, ms: lastRun.ms, videos: lastRun.videos,
        units: lastRun.units, errors: lastRun.errors?.length ?? 0, aborted: lastRun.aborted ?? null
      },
      total_videos: count ?? 0,
      units_today: units,
      quota_limit: QUOTA_LIMIT,
      quota_date: quotaDate() // 태평양 자정 기준
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/channels/refresh', requireAuth, async (req, res) => {
  try {
    const r = await refreshChannels(true)
    addUnitsToday(r.units)
    res.json(r)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/collect', requireAuth, async (req, res) => {
  try {
    if (collecting) {
      return res.status(409).json({ error: '이미 수집이 돌고 있어요. 끝나면 화면이 갱신됩니다' })
    }
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
