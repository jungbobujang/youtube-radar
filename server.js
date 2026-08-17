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

function quotaDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
}

function unitsFile(date = quotaDate()) {
  return path.join(LOG_DIR, `units-${date}.json`)
}

// 옛 파일에는 by 가 없다. 없으면 빈 칸으로 읽는다.
function readUnitsFile() {
  try {
    const j = JSON.parse(fs.readFileSync(unitsFile(), 'utf8'))
    return { units: Number(j.units) || 0, by: j.by ?? {} }
  } catch {
    return { units: 0, by: {} } // 오늘 첫 수집이면 파일이 없다
  }
}

function readUnitsToday() {
  return readUnitsFile().units
}

// source 를 주면 어디에 썼는지도 따로 센다 (댓글 수집이 얼마나 먹는지 상태바에 보이게)
function addUnitsToday(n, source = 'etc') {
  if (!n) return
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const date = quotaDate()
    const cur = readUnitsFile()
    const by = { ...cur.by }
    by[source] = (Number(by[source]) || 0) + Number(n)
    fs.writeFileSync(
      unitsFile(date),
      JSON.stringify({ date, units: cur.units + Number(n), by })
    )
  } catch (e) {
    console.warn(`[quota] 사용량 기록 실패: ${e.message}`)
  }
  // DB 장부는 따로. 실패해도 수집을 멈추지 않는다.
  logQuotaUnits(n, source).catch((e) => console.warn(`[quota] DB 기록 실패: ${e.message}`))
}

// ---------------------------------------------------------------- 할당량 합산 장부
//
// 같은 API 키를 Railway·집·학교에서 같이 쓴다. 인스턴스마다 자기 파일만 보면
// "오늘 얼마 썼나" 가 늘 실제보다 적게 나온다. 쓴 만큼 DB 에 한 줄씩 남기고,
// 상태바는 태평양 날짜 기준으로 전부 합산해 보여 준다.
// 파일 기록도 그대로 남긴다 (DB 가 안 될 때 쓰는 로컬 참고치).
let quotaLogAvailable = null

async function quotaTableReady() {
  if (quotaLogAvailable !== null) return quotaLogAvailable
  const { error } = await supabase.from('yt_quota_log').select('id').limit(1)
  quotaLogAvailable = !error
  if (!quotaLogAvailable) {
    console.warn(`[quota] yt_quota_log 테이블이 아직 없습니다 (TODO-SQL.md 0-D 참고): ${error.message}`)
  }
  return quotaLogAvailable
}

// 태평양 '오늘' 이 시작된 순간의 UTC 시각.
// 태평양은 UTC-7(서머타임) 또는 UTC-8 이라 후보가 둘뿐이다. 그중 태평양으로 읽었을 때
// 오늘 00시가 되는 쪽을 고른다. (흐른 시간만큼 되감는 방식은 서머타임 전환일에 한 시간 어긋난다.)
function pacificDayStart(now = new Date()) {
  const date = quotaDate(now)
  const readPacific = (d) => {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
    }).formatToParts(d)
    const get = (t) => p.find((x) => x.type === t)?.value ?? ''
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 }
  }

  for (const offset of [7, 8]) {
    const guess = new Date(`${date}T00:00:00.000Z`)
    guess.setUTCHours(guess.getUTCHours() + offset)
    const p = readPacific(guess)
    if (p.date === date && p.hour === 0) return guess
  }
  // 여기 올 일은 없지만, 오면 넉넉하게 UTC-8 로 잡는다 (덜 세느니 더 세는 쪽)
  const fallback = new Date(`${date}T00:00:00.000Z`)
  fallback.setUTCHours(fallback.getUTCHours() + 7)
  return fallback
}

async function logQuotaUnits(units, source) {
  if (!Number(units)) return
  if (!(await quotaTableReady())) return
  const { error } = await supabase
    .from('yt_quota_log').insert({ units: Number(units), source: String(source ?? 'etc') })
  if (error) console.warn(`[quota] DB 기록 실패: ${error.message}`)
}

// 태평양 오늘치 전부를 합산한다. 테이블이 없으면 null 을 돌려주고 파일값으로 넘어간다.
async function unitsTodayFromDb() {
  if (!(await quotaTableReady())) return null
  const { data, error } = await supabase
    .from('yt_quota_log').select('units, source')
    .gte('used_at', pacificDayStart().toISOString())
    .limit(5000)
  if (error) {
    console.warn(`[quota] DB 합산 실패: ${error.message}`)
    return null
  }
  const by = {}
  let units = 0
  for (const r of data ?? []) {
    const n = Number(r.units) || 0
    const key = r.source || 'etc'
    units += n
    by[key] = (by[key] || 0) + n
  }
  return { units, by, entries: (data ?? []).length }
}

// 할당량은 앱이 아니라 구글 프로젝트 단위다. 이 문장을 오류마다 같이 내보낸다.
const QUOTA_NOTE = '할당량은 이 앱이 아니라 같은 API 키를 쓰는 구글 클라우드 프로젝트 전체 기준입니다. ' +
  '태평양 자정(한국 시간 오후 4~5시경)에 리셋됩니다.'

// 수집은 할당량이 바닥나도 예외를 던지지 않고 사이클만 접는다(aborted='quota').
// 그대로 200 으로 돌려주면 화면에는 '0건 수집' 처럼 보이므로 여기서 잡아 준다.
function sentQuotaAbort(res, report) {
  if (report?.aborted !== 'quota') return false
  res.status(429).json({ error: `할당량이 바닥났어요. ${QUOTA_NOTE}`, quota: true, report })
  return true
}

// 할당량 오류면 429 로, 그 밖은 500 으로. 문구에 리셋 안내를 붙인다.
function sendYtError(res, err) {
  if (isQuotaError(err)) {
    return res.status(429).json({ error: `할당량이 바닥났어요. ${QUOTA_NOTE}`, quota: true })
  }
  res.status(500).json({ error: err.message })
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

// source 는 문자열, 또는 통계만 다시 읽는 경우처럼 영상마다 원래 출처를 지켜야 할 때
// video_id -> source 인 Map 을 준다 (출처가 바뀌면 점수까지 따라 바뀐다).
async function saveVideos(items, source, cfg, opts = {}) {
  if (items.length === 0) return 0
  const sourceOf = (id) => (source instanceof Map ? (source.get(id) ?? 'refresh') : source)

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
    score: scoreVideo(v, cfg, sourceOf(v.id)),
    source: sourceOf(v.id)
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

// ---------------------------------------------------------------- 민감 주제
//
// 교사 신분이라 D 채널(본명·얼굴)에는 올리기 어려운 주제들이다. 걸러 버리는 게 아니라
// 🅐 전용으로 따로 모아 두고, 용도 태그도 A 로 미리 잡아 준다.
//
// 낱말이 제목에 그대로 들어 있으면 걸린다(부분 일치). 편집은 이 배열만 고치면 된다.
// - 너무 넓게 잡으면 "AI 반도체 전쟁" 처럼 비유까지 걸린다. 그래도 A 로 분류될 뿐
//   목록에서 사라지지는 않으니, 애매하면 넣어 두는 편이 안전하다.
// - 반대로 특정 표현만 빼고 싶으면 그 줄만 지우면 된다.
const SENSITIVE_KEYWORDS = [
  // 정치 일반
  '정치', '정당', '대통령', '국회', '의원', '선거', '탄핵', '진보', '보수', '좌파', '우파',
  // 집회·충돌
  '시위', '집회', '내란', '계엄', '쿠데타', '혁명', '천안문', '전쟁', '분쟁', '학살',
  // 혐오·갈등
  '혐오', '젠더', '페미', '남녀갈등', '차별', '인종',
  // 종교
  '종교', '기독교', '이슬람', '불교', '천주교', '이단', '사이비',
  // 국가 감정 — 국가 이름 자체가 아니라 '깎아내리는 말' 을 본다.
  // ("중국 경제 분석" 은 걸리면 안 되고 "미개한 중국" 은 걸려야 한다)
  '저주받은', '미개', '미개한', '열등', '혐한', '반일', '반중', '친중', '친일',
  '국뽕', '쳐발린', '몰락한 민족', '극혐', '식민', '위안부', '독도'
]

// 국가명 + 부정어 조합. 낱말 하나만으로는 못 잡는 프레임을 걸러 낸다.
// 예) "중국어는 저주받은 언어다", "일본 극혐" — 둘 다 국가명과 부정어가 같이 있다.
// 국가명만 있거나 부정어만 있으면 걸리지 않는다.
const COUNTRY_RE = /(중국|중공|일본|왜놈|한국|조선|북한|대만|미국|러시아|인도|베트남|필리핀)/
const NEGATIVE_RE = /(저주|혐오|극혐|미개|열등|망한|몰락|폭망|후진|쳐발|짱깨|쪽바리|섬나라|국뽕)/

// 제목에 걸린 낱말들. 화면에는 앞의 몇 개만 보여 준다.
function sensitiveHits(title) {
  const t = String(title ?? '')
  const hits = SENSITIVE_KEYWORDS.filter((w) => t.includes(w))

  const country = t.match(COUNTRY_RE)
  const negative = t.match(NEGATIVE_RE)
  if (country && negative) hits.push(`${country[0]}+${negative[0]}`)

  return [...new Set(hits)]
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
  TREND_WINDOW_D: 90,     // 채널 활력 한 구간 길이(일). 최근 N일 vs 그 이전 N일
  TREND_MIN_SAMPLE: 5,    // 각 구간에 영상이 이만큼은 있어야 판정한다
  TREND_DECLINE: 0.5,     // 이 아래면 ⚠️ 쇠락
  TREND_RISE: 1.5,        // 이 위면 📈 상승
  TREND_TTL_MIN: 60,      // 활력 계산 캐시 유지(분). 채널 추세는 시간 단위로 안 변한다
  REACH_PCT_FLOOR: 0.25,  // 발굴점수의 침투력 항 하한 (0 이면 최하위가 점수를 0으로 만든다)
  HOT_ENGAGE_PCTL: 0.75,  // 참여율 상위 25% 에 💬 진한반응
  CHANNEL_TTL_H: 24,      // 구독자 수 갱신 주기(시간)
  MEDIAN_WINDOW_D: 90,    // 채널활력용 최근 N일
  DEBATE_RATIO: 0.15,     // 댓글/좋아요가 이 위면 🗣️ 토론형
  VELOCITY_WINDOW_D: 7,   // 에버그린 최근 증가량 창(일)
  SATURATION_WINDOW_D: 90,// 주제 포화도를 볼 최근 N일
  SATURATION_KEYWORDS: 2, // 영상 1건당 포화도를 세볼 핵심 낱말 개수
  SATURATION_WARN: 2,     // 다른 채널 이만큼부터 ⚠️ 재탕 경고
  WEEKLY_TOP: 10,         // 주간 리포트 신작 상위 개수
  WEEKLY_DIG_MIN: 5,      // 주간 리포트에 올릴 최소 배율
  WEEKLY_DIG_MAX: 20      // 주간 리포트 발굴분 최대 개수
}

// ---------------------------------------------------------------- 체급
//
// 침투력과 활력은 구독자 수에 직접 매인 지표다. 100만 채널의 침투력 0.5 와
// 1만 채널의 0.5 는 전혀 다른 사건인데, 한 줄로 세우면 큰 채널이 늘 아래에 깔린다.
// 그래서 등급·경고·발굴점수는 모두 "같은 체급 안에서" 본다.
const SUB_TIERS = [
  { key: 't1', label: '~5만', min: 0, max: 50000 },
  { key: 't2', label: '5~30만', min: 50000, max: 300000 },
  { key: 't3', label: '30~100만', min: 300000, max: 1000000 },
  { key: 't4', label: '100만+', min: 1000000, max: Infinity }
]

const TIER_LABEL = new Map(SUB_TIERS.map((t) => [t.key, t.label]))

// 구독자 수를 아직 모르는 채널은 체급이 없다 (등급·경고에서 제외된다)
function subTier(subs) {
  const n = Number(subs ?? 0)
  if (!(n > 0)) return null
  return (SUB_TIERS.find((t) => n >= t.min && n < t.max) ?? SUB_TIERS[SUB_TIERS.length - 1]).key
}

function median(sorted) {
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// ---------------------------------------------------------------- 채널 활력
//
// 활력 = 최근 90일 조회 중앙값 ÷ 그 이전 90일 조회 중앙값.
//
// 예전 정의는 "최근 중앙값 ÷ 구독자수" 였다. 그 식은 방송사 아카이브 채널을
// 상시로 ⚠️ 로 만든다. EBS 는 구독자가 543만이라 무엇을 올려도 비율이 바닥이지
// 채널이 죽은 게 아니다. 자기 과거와 견주면 "요즘 성적이 떨어지고 있나" 라는
// 원래 물음에 그대로 답할 수 있고, 채널 크기와도 무관해진다.
let trendCache = { at: 0, map: new Map() }

function invalidateTrends() {
  trendCache = { at: 0, map: new Map() }
}

async function channelTrends() {
  if (trendCache.map.size > 0 && Date.now() - trendCache.at < METRIC.TREND_TTL_MIN * 60e3) {
    return trendCache.map
  }

  const win = METRIC.TREND_WINDOW_D * DAY
  const mid = Date.now() - win
  const since = new Date(Date.now() - 2 * win).toISOString()

  // 180일치를 한 번에 훑는다. PostgREST 기본 상한(1000행)에 조용히 잘리지 않게 페이지로 나눈다.
  const PAGE_SIZE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('yt_videos')
      .select('channel_id, published_at, views')
      .gte('published_at', since)
      .not('channel_id', 'is', null)
      .order('published_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      console.warn(`[metric] 채널 활력 계산 실패: ${error.message}`)
      return trendCache.map // 이전 값이라도 쓴다 (없으면 빈 맵 → 표시 안 함)
    }
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE_SIZE) break
  }

  const buckets = new Map()
  for (const r of rows) {
    const t = new Date(r.published_at).getTime()
    if (!Number.isFinite(t)) continue
    if (!buckets.has(r.channel_id)) buckets.set(r.channel_id, { recent: [], prev: [] })
    const b = buckets.get(r.channel_id)
    ;(t >= mid ? b.recent : b.prev).push(Number(r.views ?? 0))
  }

  const map = new Map()
  for (const [id, b] of buckets) {
    const recentMed = median(b.recent.sort((a, c) => a - c))
    const prevMed = median(b.prev.sort((a, c) => a - c))
    // 어느 한쪽이라도 표본이 모자라면 판정 보류. 이전 중앙값이 0 이면 비율을 못 낸다.
    const enough =
      b.recent.length >= METRIC.TREND_MIN_SAMPLE &&
      b.prev.length >= METRIC.TREND_MIN_SAMPLE &&
      prevMed > 0

    map.set(id, {
      recent_median: recentMed,
      prev_median: prevMed,
      recent_n: b.recent.length,
      prev_n: b.prev.length,
      ratio: enough ? recentMed / prevMed : null
    })
  }

  trendCache = { at: Date.now(), map }
  return map
}

async function channelContext() {
  const [chans, trends] = await Promise.all([channelMap(), channelTrends()])
  return { chans, trends }
}

// 같은 체급 안에서의 백분위(0~1). 동점은 중간 순위로 본다.
function percentileRank(sorted, x) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return 0.5
  let below = 0
  let equal = 0
  for (const n of sorted) {
    if (n < x) below++
    else if (n === x) equal++
  }
  return (below + equal / 2) / sorted.length
}

// 발굴점수의 침투력 항을 "체급 내 백분위" 로 갈아끼운다.
// 절대값 log(1+침투력) 을 쓰면 구독자가 적을수록 유리해 큰 채널 영상이 부당하게 밀린다.
function rescoreByTier(rows) {
  const pools = new Map()
  for (const v of rows) {
    if (v.reach == null) continue
    const key = v.tier ?? 'unknown'
    if (!pools.has(key)) pools.set(key, [])
    pools.get(key).push(Number(v.reach))
  }
  for (const arr of pools.values()) arr.sort((a, b) => a - b)

  for (const v of rows) {
    const pool = pools.get(v.tier ?? 'unknown')
    // 침투력을 모르면(구독자 미확인) 중립값 0.5 로 둔다
    const pct = v.reach == null || !pool ? 0.5 : percentileRank(pool, Number(v.reach))
    v.reach_pct = Number(pct.toFixed(3))

    const term = METRIC.REACH_PCT_FLOOR + (1 - METRIC.REACH_PCT_FLOOR) * pct
    v.dig_score = Number((
      Math.log(1 + Math.max(Number(v.multiple ?? 0), 0)) *
      term *
      (1 + Number(v.engage ?? 0) / METRIC.ENGAGE_DIVISOR)
    ).toFixed(2))
  }
  return rows
}

function deriveMetrics(v, channel, trend) {
  const views = Number(v.views ?? 0)
  const likes = Number(v.like_count ?? 0)
  const comments = Number(v.comment_count ?? 0)
  const subs = Number(channel?.subscriber_count ?? 0)

  const reach = subs > 0 ? views / subs : null                 // 침투력
  const engage = views > 0
    ? ((likes + comments * METRIC.COMMENT_WEIGHT) / views) * 100
    : 0                                                        // 참여율 %
  const vitality = trend?.ratio ?? null                        // 채널활력 (최근 90일 ÷ 이전 90일)
  const multiple = Number(v.multiple ?? 0)

  // 토론성 — 좋아요 대비 댓글. 참여율(💬 진한반응)과는 다른 축이다.
  // 참여율은 "반응이 많은가", 토론성은 "그 반응이 말로 나오는가" 를 본다.
  // 좋아요가 0 이면 대개 표시가 꺼진 영상이라 비율을 내지 않는다.
  const debate = likes > 0 ? comments / likes : null

  // 구독자 수를 아직 모르면 침투력을 1로 두어 배율·참여율만으로 점수를 낸다.
  // 목록 전체를 볼 수 있는 rescoreByTier() 가 이 값을 체급 백분위 기준으로 덮어쓴다.
  const digScore =
    Math.log(1 + Math.max(multiple, 0)) *
    Math.log(1 + Math.max(reach ?? 1, 0)) *
    (1 + engage / METRIC.ENGAGE_DIVISOR)

  const tier = subTier(subs)

  // 활력은 자기 과거와의 비교라 채널 크기와 무관하다. 체급 보정이 필요 없다.
  // 표본이 모자라면(어느 한쪽 구간 영상 5개 미만) ratio 가 null 이고 아무것도 표시하지 않는다.
  return {
    // 민감 주제는 목록마다 따로 계산할 것 없이 지표를 붙일 때 같이 본다
    sensitive: sensitiveHits(v.title),
    reach: reach == null ? null : Number(reach.toFixed(2)),
    engage: Number(engage.toFixed(2)),
    vitality: vitality == null ? null : Number(vitality.toFixed(2)),
    vitality_pending: vitality == null,
    vitality_recent: trend?.recent_median ?? null,
    vitality_prev: trend?.prev_median ?? null,
    vitality_n: trend ? [trend.recent_n, trend.prev_n] : null,
    dig_score: Number(digScore.toFixed(2)),
    tier,
    tier_label: tier ? TIER_LABEL.get(tier) : null,
    dead_channel: vitality != null && vitality < METRIC.TREND_DECLINE,
    rising_channel: vitality != null && vitality >= METRIC.TREND_RISE,
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

// 세 지표는 축이 다르므로 각자의 분포로 따로 줄 세운다.
// 침투력만은 전체가 아니라 같은 체급 안에서 비교한다 — 구독자 수에 직접 매인 지표라
// 한 줄로 세우면 큰 채널이 늘 Low 로 깔린다.
function attachGrades(rows) {
  const num = (n) => (n == null ? null : Number(n))
  const g = {
    multiple: gradeBy(rows, (v) => num(v.multiple)),
    engage: gradeBy(rows, (v) => num(v.engage))
  }

  const byTier = new Map()
  for (const v of rows) {
    const key = v.tier ?? 'unknown'
    if (!byTier.has(key)) byTier.set(key, [])
    byTier.get(key).push(v)
  }
  // 체급 표본이 GRADE_MIN_SAMPLE 미만이면 그 체급은 등급을 비운다 (숫자만 보여준다)
  const reachGrade = new Map()
  for (const [key, group] of byTier) {
    reachGrade.set(key, gradeBy(group, (v) => num(v.reach)))
  }

  for (const v of rows) {
    v.grade = {
      multiple: g.multiple(num(v.multiple)),
      reach: reachGrade.get(v.tier ?? 'unknown')(num(v.reach)),
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
// 낱말 하나만 보면 우연히 안 겹칠 수 있어 변별력 상위 2개를 각각 세고 큰 쪽을 쓴다.
// (DB 함수는 payload 행 단위로 세므로 같은 video_id 가 여러 줄이어도 그대로 동작한다)
async function saturationMap(rows) {
  const payload = []
  for (const v of rows) {
    for (const keyword of extractKeywords(v.title).slice(0, METRIC.SATURATION_KEYWORDS)) {
      if (keyword.length >= 2) {
        payload.push({ video_id: v.video_id, channel_id: v.channel_id, keyword })
      }
    }
  }
  if (payload.length === 0) return new Map()

  const { data, error } = await supabase.rpc('topic_saturation', {
    payload, window_days: METRIC.SATURATION_WINDOW_D
  })
  if (error) {
    console.warn(`[metric] 주제 포화도 계산 실패(함수 없음?): ${error.message}`)
    return new Map()
  }

  const out = new Map()
  for (const r of data ?? []) {
    const n = Number(r.channels ?? 0)
    out.set(r.video_id, Math.max(out.get(r.video_id) ?? 0, n))
  }
  return out
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
  return { updated: rows.length, units, snapshots: await snapshotChannels(rows) }
}

// ---------------------------------------------------------------- 구독자 이력

// 구독자 수는 yt_channels 에 최신값만 남아 덮어써진다. 추이를 보려면 따로 쌓아야 한다.
// 테이블이 아직 없으면 조용히 건너뛴다 (TODO-SQL.md 참고).
async function snapshotChannels(rows) {
  if (rows.length === 0) return 0

  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)

  const { data: today, error } = await supabase
    .from('yt_channel_snapshots')
    .select('channel_id')
    .gte('captured_at', dayStart.toISOString())
  if (error) {
    console.warn(`[channel] 구독자 이력 생략(테이블 없음?): ${error.message}`)
    return 0
  }

  // 하루 한 건만 남긴다. 강제 갱신을 여러 번 눌러도 그날 기록은 늘지 않는다.
  const have = new Set((today ?? []).map((r) => r.channel_id))
  const fresh = rows
    .filter((r) => !have.has(r.channel_id))
    .map((r) => ({ channel_id: r.channel_id, subscriber_count: r.subscriber_count }))
  if (fresh.length === 0) return 0

  const { error: iErr } = await supabase.from('yt_channel_snapshots').insert(fresh)
  if (iErr) {
    console.warn(`[channel] 구독자 이력 기록 실패: ${iErr.message}`)
    return 0
  }
  return fresh.length
}

const GROWTH_WINDOW_D = 7
const GROWTH_MIN_SPAN_D = 6 // 7일치가 차기 전에는 '측정 중' 으로 둔다

// 채널 id -> 최근 7일 구독자 증가. 하루 1건씩이라 채널당 8행이면 충분하다.
async function channelGrowth() {
  const since = new Date(Date.now() - (GROWTH_WINDOW_D + 1) * DAY).toISOString()
  const { data, error } = await supabase
    .from('yt_channel_snapshots')
    .select('channel_id, subscriber_count, captured_at')
    .gte('captured_at', since)
    .order('captured_at', { ascending: true })
    .limit(2000)
  if (error) return {} // 테이블이 없으면 화면에서 이 항목만 빠진다

  const by = {}
  for (const s of data ?? []) (by[s.channel_id] ??= []).push(s)

  const out = {}
  for (const [id, arr] of Object.entries(by)) {
    const first = arr[0]
    const last = arr[arr.length - 1]
    const days = (new Date(last.captured_at) - new Date(first.captured_at)) / DAY
    out[id] = days >= GROWTH_MIN_SPAN_D
      ? {
          pending: false,
          days: Math.round(days),
          subs: Number(last.subscriber_count),
          delta: Number(last.subscriber_count) - Number(first.subscriber_count)
        }
      : { pending: true, days: Math.round(days) }
  }
  return out
}

async function channelMap() {
  const { data } = await supabase.from('yt_channels').select('*')
  return new Map((data ?? []).map((c) => [c.channel_id, c]))
}

// ---------------------------------------------------------------- 수집 주기·갱신 정책
//
// 할당량 절약 모드. 정규 수집은 하루 2회만 돌고, 통계(스냅샷)는 영상 성격별로
// 갱신 주기를 달리한다. 상수는 전부 여기서 조절한다.
const COLLECT_CRON = '0 6,21 * * *'  // 하루 2회 — 한국시간 06:00 / 21:00
const COLLECT_TZ = 'Asia/Seoul'      // 배포지(Railway)가 UTC 라도 한국 기준으로 돈다
const HOT_CRON = '0 20 * * 0'        // 🔥 HOT 탐사 — 일요일 저녁 20:00
const BOOT_COLLECT_GAP_H = 6         // 재시작 직후 수집은 마지막 수집이 이만큼 지났을 때만

// 통계 갱신 차등 — 오래된 영상까지 매번 다시 읽을 이유가 없다 (50개당 1유닛)
const REFRESH = {
  FRESH_DAYS: 30,    // 게시 30일 이내: 매 수집마다
  PICK_HOURS: 24,    // ⭐ 후보로 담은 것: 하루 1회
  BACKLOG_DAYS: 7,   // 그 밖의 백카탈로그: 주 1회
  UNIT_BUDGET: 20,   // 1회 수집에서 통계 갱신에 쓸 유닛 상한
  CANDIDATES: 400    // 한 번에 살펴볼 후보 수 (구간별)
}

// ---------------------------------------------------------------- 백카탈로그

const BACKFILL_MAX_PER_CHANNEL = 500 // 채널당 최대 보관 영상 수
const BACKFILL_UNIT_BUDGET = 260     // 1회 수집에서 백카탈로그에 쓸 유닛 상한
const PAGE = 50                      // playlistItems 한 페이지

// 업로드 목록 끝까지 훑은 채널은 더 팔 게 없다. 순회에서 빼려고 표시해 둔다.
// 컬럼을 늘리지 않으려고 설정 행(type='setting')을 그대로 쓴다.
const backfillDoneKey = (channelId) => `backfill_done:${channelId}`

async function backfillDoneSet() {
  const { data } = await supabase
    .from('yt_watches').select('value').eq('type', 'setting').like('value', 'backfill_done:%')
  return new Set((data ?? []).map((r) => String(r.value).slice('backfill_done:'.length)))
}

async function markBackfillDone(channelId, label) {
  const { error } = await supabase.from('yt_watches').insert({
    type: 'setting', value: backfillDoneKey(channelId),
    label: `백카탈로그 완료: ${label ?? channelId}`, active: true
  })
  if (error && !/duplicate/i.test(error.message)) {
    // type 제약에 'setting' 이 없으면 여기서 막힌다 (TODO-SQL.md 0-E).
    // 표시를 못 해도 수집 자체는 계속 돈다 — 다음 회차에 그 채널을 또 훑을 뿐이다.
    console.warn(`[collect] 백카탈로그 완료 표시 실패: ${error.message}`)
  }
}

// 이미 저장된 영상 수가 적은 채널부터 돈다. 별도 커서 컬럼 없이 순환이 된다.
// 상한을 채웠거나 끝까지 훑은 채널은 done 으로 표시해 아예 돌지 않는다.
async function channelBacklogState(channels) {
  const done = await backfillDoneSet()
  const out = []
  for (const w of channels) {
    const { count } = await supabase
      .from('yt_videos')
      .select('video_id', { count: 'exact', head: true })
      .eq('channel_id', w.value)
    const stored = count ?? 0
    out.push({ watch: w, stored, done: done.has(w.value) || stored >= BACKFILL_MAX_PER_CHANNEL })
  }
  return out.sort((a, b) => a.stored - b.stored)
}

// 한 채널의 업로드 재생목록을 페이지네이션하며 아직 없는 영상만 채운다.
async function backfillChannel(w, cfg, budget) {
  let used = 0
  let pageToken
  let seen = 0
  let saved = 0
  let complete = false // 업로드 목록을 끝까지 봤는가

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
    if (ids.length === 0) { complete = true; break }

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
    if (!pageToken) { complete = true; break }
  }

  return { used, saved, seen, complete }
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

// ---------------------------------------------------------------- 통계 갱신 (차등)
//
// 예전에는 감시 채널의 최신 25개만 매 수집마다 다시 읽었다. 그러면 후보로 담아 둔
// 과거 영상은 스냅샷이 1개에서 늘지 않아 '측정 중' 에서 벗어나지 못한다.
// 그렇다고 전부 매번 읽으면 유닛이 감당이 안 된다. 그래서 성격별로 주기를 나눈다.

let backlogCursor = 0 // 백카탈로그를 조금씩 돌아가며 훑기 위한 위치 (재시작하면 처음부터)

// 마지막 스냅샷이 maxAgeMs 보다 오래된 영상만 남긴다.
// video_velocity 함수가 영상별 최신 스냅샷 시각을 한 번에 준다.
async function dueForRefresh(ids, maxAgeMs) {
  if (ids.length === 0) return []
  const { data, error } = await supabase.rpc('video_velocity', { ids, window_days: 1 })
  if (error) {
    console.warn(`[collect] 갱신 대상 판정 실패(함수 없음?): ${error.message}`)
    return ids // 판단할 수 없으면 그냥 대상으로 본다
  }
  const latest = new Map((data ?? []).map((r) => [r.video_id, r.latest_at]))
  return ids.filter((id) => {
    const at = latest.get(id)
    return !at || Date.now() - new Date(at).getTime() >= maxAgeMs
  })
}

const idsOf = (rows) => (rows ?? []).map((r) => r.video_id)

async function refreshVideoStats(cfg) {
  const out = { videos: 0, used: 0, fresh: 0, picks: 0, backlog: 0 }
  const freshSince = new Date(Date.now() - REFRESH.FRESH_DAYS * DAY).toISOString()

  // 1) 신작 — 매 수집마다 (증가량 추이가 여기서 나온다)
  const { data: freshRows } = await supabase
    .from('yt_videos').select('video_id')
    .gte('published_at', freshSince)
    .order('published_at', { ascending: false }).limit(REFRESH.CANDIDATES)

  // 2) ⭐ 후보 — 하루 1회
  let pickRows = []
  if (await pickColumnsReady()) {
    const { data } = await supabase
      .from('yt_videos').select('video_id').gte('pick_level', 1).limit(REFRESH.CANDIDATES)
    pickRows = data ?? []
  }

  // 3) 그 밖의 백카탈로그 — 주 1회. 매번 앞에서부터 보면 뒤쪽은 영영 안 도니 커서를 민다.
  const { data: backlogRows } = await supabase
    .from('yt_videos').select('video_id')
    .lt('published_at', freshSince)
    .order('first_seen_at', { ascending: true })
    .range(backlogCursor, backlogCursor + REFRESH.CANDIDATES - 1)
  if ((backlogRows ?? []).length < REFRESH.CANDIDATES) backlogCursor = 0
  else backlogCursor += REFRESH.CANDIDATES

  const [fresh, picks, backlog] = await Promise.all([
    dueForRefresh(idsOf(freshRows), 0),
    dueForRefresh(idsOf(pickRows), REFRESH.PICK_HOURS * 3600e3),
    dueForRefresh(idsOf(backlogRows), REFRESH.BACKLOG_DAYS * DAY)
  ])
  out.fresh = fresh.length
  out.picks = picks.length
  out.backlog = backlog.length

  // 급한 순서대로 붙이고 중복을 걷어낸 뒤, 예산만큼만 읽는다
  const queue = [...new Set([...fresh, ...picks, ...backlog])].slice(0, REFRESH.UNIT_BUDGET * 50)
  if (queue.length === 0) return out

  // 통계만 다시 읽는 것이므로 원래 출처(source)를 그대로 지켜 준다
  const { data: known } = await supabase
    .from('yt_videos').select('video_id, source').in('video_id', queue)
  const sources = new Map((known ?? []).map((r) => [r.video_id, r.source ?? 'refresh']))

  for (let i = 0; i < queue.length && out.used < REFRESH.UNIT_BUDGET; i += 50) {
    const batch = queue.slice(i, i + 50)
    const details = await fetchVideoDetails(batch)
    out.used += 1
    out.videos += await saveVideos(details, sources, cfg)
  }
  return out
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
  return {
    trendingOn: flags.has('trending_on'), // 기본 off
    prospectOn: flags.has('prospect_on'), // 정규 수집에 키워드 검색 포함 — 기본 off
    // 🔥 HOT 주간 탐사만 기본 on 이다. 끄면 'hot_weekly_off' 행이 생긴다.
    hotWeeklyOn: !flags.has('hot_weekly_off')
  }
}

// 한 단계가 실패해도 다음 단계는 계속한다.
// 다만 할당량이 바닥나면 뒤 단계도 전부 같은 오류를 받을 뿐이라 그 자리에서 접는다.
async function runCycle(report, opts = {}) {
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

  // '지금 탐사' 는 키워드 검색만 돌린다. 채널·백카탈로그까지 같이 돌리면
  // 버튼 한 번에 정규 수집 한 사이클을 통째로 더 쓰게 된다.
  const only = opts.only ?? null

  // a. 인기 급상승 — 기본은 꺼져 있다 (백카탈로그 발굴로 전략 전환)
  if (settings.trendingOn && !only) {
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
    if (only === 'prospect' && w.type !== 'keyword') continue
    // 한 감시 대상이 실패해도 나머지는 계속한다
    try {
      let ids = []

      if (w.type === 'keyword') {
        // 새 광맥 탐사 — 검색 말고 방법이 없어 1건당 100유닛이다.
        // 자동 사이클에서는 기본으로 끄고, 감시 관리 토글이나 '지금 탐사' 버튼으로만 돈다.
        if (!settings.prospectOn && !opts.prospect) {
          report.prospect_skipped = (report.prospect_skipped ?? 0) + 1
          continue
        }
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
  const channels = only ? [] : watches.filter((w) => w.type === 'channel')
  if (channels.length > 0) {
    let budget = BACKFILL_UNIT_BUDGET
    report.backfill = {}
    try {
      for (const { watch, done } of await channelBacklogState(channels)) {
        if (budget < 3) break
        // 상한을 채웠거나 업로드 목록을 끝까지 훑은 채널은 더 팔 게 없다
        if (done) { report.backfill_done = (report.backfill_done ?? 0) + 1; continue }
        try {
          const r = await backfillChannel(watch, cfg, budget)
          budget -= r.used
          report.units += r.used
          if (r.saved > 0) report.backfill[watch.label || watch.value] = r.saved
          if (r.complete) await markBackfillDone(watch.value, watch.label)
        } catch (err) {
          if (noteError(report, `백카탈로그 ${watch.label || watch.value}`, err)) return
        }
      }
    } catch (err) {
      if (noteError(report, '백카탈로그', err)) return
    }
  }

  // c-1. 통계 갱신 — 신작은 매번, ⭐ 후보는 하루 1회, 나머지 백카탈로그는 주 1회
  if (!only) {
    try {
      const r = await refreshVideoStats(cfg)
      report.refreshed = r
      report.units += r.used
    } catch (err) {
      if (noteError(report, '통계 갱신', err)) return
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
  }

  // e. 채널별 중앙값 대비 배율 갱신
  try {
    report.multiples = await recomputeMultiples()
  } catch (err) {
    noteError(report, '배율', err)
  }
}

// 수동 수집과 cron 이 겹치면 같은 일을 두 번 하며 할당량만 태운다. 한 번에 하나만 돈다.
// opts.prospect 를 주면 이번 회차만 키워드 탐사(100유닛/건)를 함께 돈다.
async function collect(opts = {}) {
  if (collecting) {
    console.warn('[collect] 이미 실행 중입니다. 이번 호출은 건너뜁니다')
    return lastRun
  }
  collecting = true

  const started = Date.now()
  const report = { trending: 0, watches: 0, videos: 0, byWatch: {}, units: 0, errors: [] }
  console.log(`[collect] 시작${opts.prospect ? ' (탐사 포함)' : ''}`)

  try {
    await runCycle(report, opts)
  } catch (err) {
    // 예상 못 한 오류까지 여기서 삼킨다. 사이클만 접히고 서버와 cron 은 그대로 산다.
    noteError(report, '수집', err)
  } finally {
    collecting = false
  }

  addUnitsToday(report.units, 'collect')
  invalidateTrends() // 새 영상이 들어왔으니 다음 조회 때 활력을 다시 계산한다

  // 수집이 끝났으니 0차 선별을 돌린다 (DB 만 본다 — 할당량 0)
  try {
    report.audition = await runAudition()
  } catch (err) {
    console.warn(`[예심] 실행 실패: ${err.message}`)
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
  const { data: videos, error } = await notHotQuery(
    supabase
      .from('yt_videos')
      .select('*')
      .gte('score', 0) // 걸러진 영상은 추이만 쌓고 화면에는 내보내지 않는다
  )
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
    addUnitsToday(1, 'channel-lookup')
    if (data.items?.[0]?.id) return data.items[0].id
  }

  // /c/이름, /user/이름 같은 옛 형태는 검색으로 (100 유닛)
  const name = raw.replace(/^https?:\/\/[^/]+\//, '').replace(/^(c|user)\//, '').split(/[/?]/)[0]
  if (name) {
    const data = await ytGet('search', { part: 'snippet', type: 'channel', q: name, maxResults: 1 })
    addUnitsToday(100, 'channel-search')
    if (data.items?.[0]?.id?.channelId) return data.items[0].id.channelId
  }
  return null
}

// ---------------------------------------------------------------- 키워드 추출

// 제목에서 검색에 쓸 만한 핵심 낱말을 뽑는다. 형태소 분석기 없이 조사/어미/불용어만 걷어낸다.
// 2어절 구는 쓰지 않는다. 같은 구를 제목에 그대로 쓰는 다른 채널이 거의 없어
// 포화도가 항상 0 으로 나왔다(TODO-SQL.md 참고).
const PARTICLES = /(은|는|이|가|을|를|의|에|에서|에게|으로|로|와|과|도|만|까지|부터|보다|처럼|라고|이라고|한테|께서|이나|나|든지|조차|마저)$/

// 용언 어미 (1) 떼면 명사 어간이 남는 것. "요리하는"→"요리",
// 한 글자만 남으면 아래 길이 필터에서 빠진다("말하는"→"말"→탈락).
const VERB_TAILS = /(하는|하며|하면서|하고|하다|한다|합니다|했다|해야|해서|하기|하면|해도|되는|된다|되다|됐다|되어|있는|있다|없는|없다|같은|같다|받는|받은|받아|받다|당하는|당한|당해|당하다|위한|위해|대한|대해|관한|관해)$/

// 용언 어미 (2) 이게 붙었으면 명사가 아니라 서술어·부사·관형형이라 통째로 버린다.
// "울었습니다"·"던져보세요"·"최적화된"·"현실적인"·"생존할" 같은 말이 뽑히던 것을 막는다.
// `.{2,}` 는 3글자 이상일 때만 걸리게 해 2글자 명사(바다, 행운, 재난, 런던)를 지키기 위한 것.
const VERB_FORMS = [
  /.{2,}다$/,                  // 죽는다, 울었습니다, 갔다
  /.{2,}요$/, /죠$/,            // 왔네요, 던져보세요
  /.{2,}(한|된|운)$/,           // 이혼한, 최적화된, 아름다운
  /적인$/,                     // 현실적인, 결정적인
  /.{2,}(할|될|볼)$/,           // 생존할, 가능할
  /[어아여워해]서$/,            // 아름다워서 (계약서·보고서는 안 걸린다)
  /.{2,}던$/,                  // 몰랐던 (런던은 두 글자라 통과)
  /.지지$/,                    // 무너지지
  /[어여아혀겨워려우]진$/,       // 밝혀진
  /[려어아]주(는|다|기)?$/,      // 알려주는
  /.{2,}며$/,                  // 손해보며
  /[아어여]야$/,                // 살아야, 해야
  /(도록|는가|지만|는데|니까|거든|이자)$/
]

// 불용어 사전 — 어느 제목에나 붙는 범용어. 포화도를 세면 수십 채널이 걸려 변별력이 없다.
// 새 범용어가 눈에 띄면 여기에만 추가하면 된다.
const STOPWORDS = [
  '그', '이', '저', '것', '수', '등', '및', '더', '왜', '어떻게', '무엇',
  '정말', '진짜', '완전', '역대급', '최고', '최악', '충격', '경악', '소름',
  '결국', '드디어', '갑자기', '가장', '너무', '아주', '다시', '지금', '오늘',
  '어제', '내일', '요즘', '우리', '당신', '여러분', '사람', '사람들',
  '이유', '방법', '이야기', '생각', '순간', '차이', '정도', '경우', '문제',
  '상황', '시작', '마지막', '전부', '모든', '가지', '번째', '개월',
  '이렇게', '그렇게', '저렇게', '절대', '과연', '도대체', '솔직히', '사실',
  '유독', '남들', '남자', '여자',
  '영상', '공식', '풀버전', '하이라이트', '레전드', '모음', '자막', '리뷰',
  'shorts', 'the', 'a', 'of', 'to', 'in', 'for', 'vs', 'feat', 'ep', 'part', 'vol'
]
const STOPWORD_SET = new Set(STOPWORDS)

const isNounish = (w) => !VERB_FORMS.some((re) => re.test(w))

// 변별력 점수 — 긴 낱말일수록 그 제목에만 있는 말일 확률이 높다("쇼펜하우어" > "가치").
// 길이가 같으면 제목 앞쪽에 나온 낱말을 택한다(보통 주제어가 앞에 온다).
function distinctiveness(word, index) {
  return word.length * 10 - Math.min(index, 9)
}

// 변별력이 높은 순으로 정렬된 낱말 목록을 준다.
// loose=true 면 용언 어미 걸러내기를 건너뛴다. 제목이 온통 서술어라 명사가 하나도
// 안 남는 경우(예: "손해보며 살아야 하는 이유") 관련 탐색이 빈손이 되지 않게 하는 예비용이다.
function extractKeywords(title, { loose = false } = {}) {
  const nounish = loose ? () => true : isNounish
  const cleaned = String(title ?? '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ') // 이모지
    .replace(/[[\]()（）{}<>|·・…"'"'`~!?.,:;#@*/\\_+=-]/g, ' ')
    .replace(/[‘’“”「」『』〈〉《》【】]/g, ' ') // 굽은 따옴표·한중일 괄호
    .replace(/[㄰-㆏]/g, ' ') // 제목 구분선으로 쓰는 홑자모 (ㅣ, ㅡ)
    .replace(/\s+/g, ' ')
    .trim()

  // 어미는 떼기 전후로 두 번 본다. "죽는다해도"→"죽는다" 처럼 떼고 나서야 드러나기도 한다.
  const words = cleaned.split(' ')
    .filter(nounish)
    .map((w) => w.replace(/^\d+/, '').replace(VERB_TAILS, '').replace(PARTICLES, ''))
    .filter((w) => w.length >= 2 && !STOPWORD_SET.has(w.toLowerCase()) &&
      !/^\d+$/.test(w) && nounish(w))

  const seen = new Set()
  const uniq = []
  words.forEach((w, i) => {
    const key = w.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    uniq.push({ word: w, rank: distinctiveness(w, i) })
  })

  return uniq.sort((a, b) => b.rank - a.rank).map((x) => x.word).slice(0, 5)
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

  const { chans, trends } = await channelContext()
  const rows = (data ?? [])
    .filter((v) => v.video_id !== excludeId)
    .map((v) => ({ ...v, ...deriveMetrics(v, chans.get(v.channel_id), trends.get(v.channel_id)) }))

  return rescoreByTier(rows)
    .sort((a, b) => b.dig_score - a.dig_score)
    .slice(0, 10)
}

// ---------------------------------------------------------------- 🔥 HOT (감시망 밖)
//
// 감시 채널 안쪽만 보면 이미 아는 광맥만 계속 판다. HOT 은 바깥을 본다.
// 검색은 1건당 100유닛이라 자동으로는 주 1회만 돌고, 나머지는 수동 버튼이다.
// 받아 온 영상은 yt_videos 에 source='hot:kr:<말>' / 'hot:global:<말>' 로 남는다.
const HOT = {
  KR_TERMS: 3,           // 국내 탐사에 쓸 관심 키워드 수 (1건당 100유닛)
  EN_TERMS: 3,           // 해외 탐사에 쓸 키워드 수 (1건당 100유닛)
  SEARCH_RESULTS: 25,    // 검색 1건당 받아올 영상 수
  SEARCH_DAYS: 365,      // 검색 대상 기간
  TRENDING_DAYS: 90,     // '지금 뜨는 주제' 로 볼 최근 기간
  TRENDING_MIN_MULT: 3,  // '지금 뜨는 주제' 최소 배율
  OUTLIER_REACH: 1,      // 아웃라이어 기준 — 조회수가 구독자 수보다 많을 것
  OUTLIER_VIEWS: 50000,  // 구독자를 모를 때 대신 볼 최소 조회수
  TOP: 30,               // 섹션별 최대 표시 수
  // 검색을 viewCount 순으로 하면 해시태그 쇼츠가 화면을 통째로 덮는다.
  // 우리 전략은 롱폼이라 3분 이하(shorts·mid)는 걸러 낸다.
  FORMATS: ['long']
}

// 관심 키워드 ↔ 영어 검색어. 해외 탐사 대상은 여기만 고치면 바뀐다.
// 왼쪽(국내어)은 '국내에서 이미 다뤄진 정도' 를 셀 때도 쓴다.
const HOT_KEYWORD_PAIRS = [
  ['자기계발', 'self improvement'],
  ['뇌과학', 'neuroscience'],
  ['습관', 'habits'],
  ['심리학', 'psychology'],
  ['동기부여', 'motivation'],
  ['미루기', 'procrastination']
]

async function watchedChannelIds() {
  const { data } = await supabase.from('yt_watches').select('value').eq('type', 'channel')
  return new Set((data ?? []).map((w) => w.value))
}

// 내 관심사는 따로 적어 두지 않는다. 담아 둔 것과 발굴 상위의 제목에서 뽑는다.
async function interestKeywords(limit) {
  const titles = []
  if (await pickColumnsReady()) {
    const { data } = await supabase
      .from('yt_videos').select('title').gte('pick_level', 1).limit(100)
    titles.push(...(data ?? []).map((r) => r.title))
  }
  const { data: digs } = await supabase
    .from('yt_videos').select('title')
    .gte('multiple', 5).gte('score', 0)
    .order('multiple', { ascending: false }).limit(100)
  titles.push(...(digs ?? []).map((r) => r.title))

  // 이미 감시 중인 채널·프로그램 이름은 뺀다. 그 말로 검색해 봐야 그 채널만 또 나온다.
  const { data: chans } = await supabase
    .from('yt_watches').select('label, value').eq('type', 'channel')
  const { data: known } = await supabase.from('yt_channels').select('title')
  // 이름 전체와 그 안의 낱말만 정확히 일치할 때 뺀다. 부분 문자열로 걸면
  // '동기부여' 같은 멀쩡한 관심어까지 채널 이름에 스쳤다는 이유로 사라진다.
  const names = new Set()
  for (const n of [...(chans ?? []).map((c) => c.label), ...(known ?? []).map((c) => c.title)]) {
    const s = String(n ?? '').trim()
    if (!s) continue
    names.add(s)
    for (const w of s.split(/\s+/)) if (w.length >= 2) names.add(w)
  }

  const count = new Map()
  for (const t of titles) {
    // 제목마다 가장 변별력 있는 낱말 2개씩만 센다
    for (const w of extractKeywords(t).slice(0, 2)) {
      count.set(w, (count.get(w) ?? 0) + 1)
    }
  }
  return [...count.entries()]
    .filter(([w, n]) => n >= 2 && w.length >= 2 && !names.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w)
}

// 검색 한 번 = search.list 100 + videos.list 1
async function hotSearch(term, source, cfg, extra = {}) {
  const publishedAfter = new Date(Date.now() - HOT.SEARCH_DAYS * DAY).toISOString()
  const found = await ytGet('search', {
    part: 'snippet', type: 'video', maxResults: HOT.SEARCH_RESULTS,
    q: term, order: 'viewCount', publishedAfter, ...extra
  })
  addUnitsToday(100, 'hot')

  const ids = (found.items ?? []).map((i) => i.id?.videoId).filter(Boolean)
  if (ids.length === 0) return { saved: 0, units: 100, ids: [] }

  const details = await fetchVideoDetails(ids)
  addUnitsToday(Math.ceil(ids.length / 50), 'hot')
  const saved = await saveVideos(details, source, cfg)
  return { saved, units: 100 + Math.ceil(ids.length / 50), ids }
}

// 감시 밖 채널의 구독자 수를 채워 둔다 (침투력 계산에 필요). 50개당 1유닛.
async function cacheDiscoveredChannels(channelIds) {
  const watched = await watchedChannelIds()
  const known = await channelMap()
  const need = [...new Set(channelIds)].filter((id) => id && !watched.has(id) && !known.has(id))
  if (need.length === 0) return { updated: 0, units: 0 }

  let units = 0
  const rows = []
  for (let i = 0; i < need.length; i += 50) {
    const data = await ytGet('channels', { part: 'snippet,statistics', id: need.slice(i, i + 50).join(',') })
    units += 1
    addUnitsToday(1, 'hot')
    for (const c of data.items ?? []) {
      rows.push({
        channel_id: c.id,
        title: c.snippet?.title ?? null,
        subscriber_count: Number(c.statistics?.subscriberCount ?? 0),
        recent_median_views: 0, // 감시 채널이 아니라 배율은 내지 않는다
        updated_at: new Date().toISOString()
      })
    }
  }
  if (rows.length > 0) {
    const { error } = await supabase.from('yt_channels').upsert(rows, { onConflict: 'channel_id' })
    if (error) throw error
  }
  return { updated: rows.length, units }
}

// 탐사 1회 비용을 미리 알려 준다 (버튼에 표시)
const hotCost = () => (HOT.KR_TERMS + HOT.EN_TERMS) * 101 + 2

async function prospectHot({ kr = true, global = true } = {}) {
  const report = { units: 0, saved: 0, terms: [], errors: [] }

  const { data: watches } = await supabase.from('yt_watches').select('*').eq('active', true)
  const cfg = {
    includeKws: (watches ?? []).filter((w) => w.type === 'include_kw').map((w) => w.value),
    excludeKws: (watches ?? []).filter((w) => w.type === 'exclude_kw').map((w) => w.value),
    categoryIds: (watches ?? []).filter((w) => w.type === 'category').map((w) => String(w.value))
  }

  const jobs = []
  if (kr) {
    for (const term of await interestKeywords(HOT.KR_TERMS)) {
      jobs.push({ term, source: `hot:kr:${term}`, extra: {}, scope: 'kr' })
    }
  }
  if (global) {
    for (const [ko, en] of HOT_KEYWORD_PAIRS.slice(0, HOT.EN_TERMS)) {
      jobs.push({
        term: en, source: `hot:global:${ko}`, scope: 'global',
        extra: { relevanceLanguage: 'en', regionCode: 'US' }
      })
    }
  }

  const foundChannels = []
  for (const job of jobs) {
    try {
      const r = await hotSearch(job.term, job.source, cfg, job.extra)
      report.units += r.units
      report.saved += r.saved
      report.terms.push({ term: job.term, scope: job.scope, saved: r.saved })

      // 방금 저장한 영상들의 채널을 모아 둔다 (구독자 수를 채우려고)
      if (r.ids.length > 0) {
        const { data } = await supabase
          .from('yt_videos').select('channel_id').in('video_id', r.ids)
        foundChannels.push(...(data ?? []).map((v) => v.channel_id))
      }
    } catch (err) {
      logFailure(`hot:${job.term}`, err)
      report.errors.push(`${job.term}: ${err.message}`)
      if (isQuotaError(err)) { report.aborted = 'quota'; break }
    }
  }

  try {
    const c = await cacheDiscoveredChannels(foundChannels)
    report.units += c.units
    report.channels = c.updated
  } catch (err) {
    report.errors.push(`채널 정보: ${err.message}`)
  }

  console.log(`[hot] 탐사 완료 — 검색 ${report.terms.length}건 · 영상 ${report.saved}건 · ${report.units}유닛`)
  return report
}

// ---------------------------------------------------------------- 자동 예심 (0차 선별)
//
// 사람이 발굴 목록을 훑으며 하던 1차 스캔을 기계가 먼저 한다.
// 통과분은 후보함의 '검토 대기' 칸에 쌓이고, 사람은 승격/제외만 누르면 된다.
// 기준은 전부 여기서 조절한다.
const AUDITION = {
  MIN_MULTIPLE: 5,        // 배율 하한
  REACH_GRADE: 'great',   // 침투력 등급 (같은 체급 안에서의 상대평가)
  ENGAGE_TOP_PCT: 0.5,    // 참여율이 자기 체급에서 상위 이만큼 안에 들 것
  MAX_SATURATION: 2,      // 다른 채널이 이보다 많이 다뤘으면 탈락
  MIN_DAYS: 182,          // 발굴 범위 시작 (6개월)
  MAX_DAYS: 1095,         // 발굴 범위 끝 (3년)
  FORMAT: 'long',         // 롱폼만
  PER_CHANNEL: 3,         // 한 채널이 검토 대기 칸을 독점하지 않게 (0 이면 제한 없음)
  CANDIDATES: 600,        // 한 번에 살펴볼 후보 수
  SATURATION_MAX: 120     // 포화도를 실제로 재 볼 최대 건수 (제목 ilike 라 비싸다)
}

let auditionReady = null

async function auditionColumnsReady() {
  if (auditionReady !== null) return auditionReady
  const { error } = await supabase
    .from('yt_videos').select('auto_picked, auto_picked_at, excluded').limit(1)
  auditionReady = !error
  if (!auditionReady) {
    console.warn(`[예심] 컬럼이 아직 없습니다 (TODO-SQL.md 0-F 참고): ${error.message}`)
  }
  return auditionReady
}

// 킵(보류)은 나중에 추가된 컬럼이라 따로 본다 (0-F 만 실행하고 0-G 는 아직일 수 있다)
let keptReady = null

async function keptColumnReady() {
  if (keptReady !== null) return keptReady
  const { error } = await supabase.from('yt_videos').select('kept').limit(1)
  keptReady = !error
  if (!keptReady) {
    console.warn(`[예심] 킵 컬럼이 아직 없습니다 (TODO-SQL.md 0-G 참고): ${error.message}`)
  }
  return keptReady
}

// 체급별 참여율 상위 ENGAGE_TOP_PCT 경계값
function engageCutByTier(rows) {
  const byTier = new Map()
  for (const v of rows) {
    const key = v.tier ?? 'unknown'
    if (!byTier.has(key)) byTier.set(key, [])
    byTier.get(key).push(Number(v.engage ?? 0))
  }
  const cuts = new Map()
  for (const [key, list] of byTier) {
    list.sort((a, b) => a - b)
    const idx = Math.floor((list.length - 1) * (1 - AUDITION.ENGAGE_TOP_PCT))
    cuts.set(key, list[idx] ?? 0)
  }
  return cuts
}

// dryRun 이면 DB 를 건드리지 않고 몇 건이 통과하는지만 센다 (소급 적용 미리보기).
async function runAudition({ dryRun = false } = {}) {
  const ready = await auditionColumnsReady()
  if (!ready && !dryRun) return { skipped: 'no-columns', passed: 0 }

  const now = Date.now()
  const newest = new Date(now - AUDITION.MIN_DAYS * DAY).toISOString()
  const oldest = new Date(now - AUDITION.MAX_DAYS * DAY).toISOString()

  let q = supabase
    .from('yt_videos').select('*')
    .gte('multiple', AUDITION.MIN_MULTIPLE)
    .gte('published_at', oldest)
    .lte('published_at', newest)
    .gte('score', 0)
    .order('multiple', { ascending: false })
    .limit(AUDITION.CANDIDATES)

  // 이미 내가 담았거나 제외한 것은 다시 올리지 않는다
  if (await pickColumnsReady()) q = q.or('pick_level.is.null,pick_level.eq.0')
  if (ready) q = q.eq('excluded', false)

  const { data, error } = await q
  if (error) throw error

  const { chans, trends } = await channelContext()
  const overrides = await formatOverrides()
  const rows = (data ?? [])
    .map((v) => ({ ...v, format: effectiveFormat(v, overrides) }))
    .filter((v) => v.format === AUDITION.FORMAT)
    .map((v) => ({ ...v, ...deriveMetrics(v, chans.get(v.channel_id), trends.get(v.channel_id)) }))

  // 등급·백분위는 발굴 탭과 같은 방식으로 후보 전체 분포에서 매긴다
  rescoreByTier(rows)
  attachGrades(rows)
  const cuts = engageCutByTier(rows)

  let shortlist = rows.filter((v) =>
    Number(v.multiple ?? 0) >= AUDITION.MIN_MULTIPLE &&
    v.grade?.reach === AUDITION.REACH_GRADE &&
    Number(v.engage ?? 0) >= (cuts.get(v.tier ?? 'unknown') ?? 0))

  // 발굴 탭과 같은 이유로 채널당 상한을 둔다. 한 채널이 잘 나가는 시기에는
  // 그 채널 영상만 조건을 통과해 검토 대기 칸이 통째로 한 채널로 찬다.
  if (AUDITION.PER_CHANNEL > 0) {
    const seen = {}
    shortlist = shortlist
      .sort((a, b) => b.dig_score - a.dig_score)
      .filter((v) => (seen[v.channel_id] = (seen[v.channel_id] ?? 0) + 1) <= AUDITION.PER_CHANNEL)
  }

  // 포화도는 제목 ilike 라 비싸다. 앞 세 조건을 통과한 것만, 그것도 상한을 두고 잰다.
  const measured = shortlist.slice(0, AUDITION.SATURATION_MAX)
  await attachSaturation(measured)
  const passed = measured.filter((v) =>
    v.saturation == null || Number(v.saturation) <= AUDITION.MAX_SATURATION)

  const report = {
    candidates: rows.length,
    shortlist: shortlist.length,
    measured: measured.length,
    passed: passed.length,
    marked: 0,
    dry_run: dryRun,
    sample: passed.slice(0, 10).map((v) => ({
      title: String(v.title).slice(0, 40), channel: v.channel_title,
      multiple: v.multiple, reach: v.reach, engage: v.engage, saturation: v.saturation
    }))
  }
  if (dryRun || !ready) return report

  // 이미 통과 표시된 것은 건드리지 않는다 (검토 대기 순서가 흔들리지 않게)
  const fresh = passed.filter((v) => !v.auto_picked).map((v) => v.video_id)
  if (fresh.length > 0) {
    const { error: uErr } = await supabase
      .from('yt_videos')
      .update({ auto_picked: true, auto_picked_at: new Date().toISOString() })
      .in('video_id', fresh)
    if (uErr) throw uErr
    report.marked = fresh.length
  }
  return report
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
    const { data: videos, error } = await notHotQuery(
      supabase
        .from('yt_videos')
        .select('*')
        .gte('score', 0)
        .gte('first_seen_at', since)
    )
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

    res.json(hidePicked(
      onlyWatched(videos)
        .map((v) => ({ ...v, views: latest[v.video_id] ?? 0 }))
        .sort((a, b) => b.views - a.views),
      req
    ))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 담아 둔 영상(pick_level >= 1)을 목록에서 뺀다.
// ?picked=1 이면 그대로 두고(⭐ 포함 보기), 컬럼이 아직 없으면 아무것도 하지 않는다.
// 이관 전 행은 pick_level 이 null 일 수 있어 null 도 '안 담김' 으로 본다.
//
// async 로 만들면 안 된다. supabase 쿼리 빌더는 thenable 이라, async 함수가 이걸
// 반환하는 순간 await 되어 쿼리가 그 자리에서 실행되고 호출부는 빌더 대신 결과 객체를
// 받는다. 그러면 뒤이어 .eq() 를 부를 때 "q.eq is not a function" 으로 터진다
// (채널·그룹 필터를 걸었을 때만 드러나서 기본 화면 확인만으로는 놓쳤다).
function excludePicked(query, req, ready) {
  if (req.query.picked === '1' || !ready) return query
  return query.or('pick_level.is.null,pick_level.eq.0')
}

// 쿼리에 조건을 걸기 어려운(또는 목록이 짧은) 탭은 받아 온 뒤에 거른다.
// 후보함이 유일한 별 모음이 되도록 모든 목록에서 담긴 것을 뺀다.
const hidePicked = (rows, req) =>
  req.query.picked === '1' ? rows : (rows ?? []).filter((v) => Number(v.pick_level ?? 0) < 1)

// HOT 탐사로 들어온 영상(감시망 밖·해외)은 🔥 HOT 탭과 후보함에서만 본다.
// 추적·급상승·레이더·주간은 감시 채널 중심 화면이라 섞이면 읽기가 어려워진다.
const isOutsideWatch = (v) => String(v?.source ?? '').startsWith('hot:')
const onlyWatched = (rows) => (rows ?? []).filter((v) => !isOutsideWatch(v))

// 쿼리 단계에서 빼는 판. limit 이 걸린 목록은 받아 온 뒤에 거르면
// 상한을 해외 영상이 다 차지해 정작 볼 것이 몇 건 안 남는다 (실측 60건 → 8건).
// source 가 null 인 옛 행까지 날아가지 않게 is.null 을 함께 둔다.
const notHotQuery = (q) => q.or('source.is.null,source.not.like.hot:*')

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
    // 담아 둔 영상은 기본으로 빠진다. 같은 걸 두 번 검토하지 않기 위해서다.
    q = excludePicked(q, req, await pickColumnsReady())
    if (channel !== 'all') q = q.eq('channel_id', channel)
    if (group !== 'all') {
      const ids = await groupChannelIds(group)
      if (ids.length === 0) return res.json([])
      q = q.in('channel_id', ids)
    }

    const { data, error } = await q
    if (error) throw error

    const { chans, trends } = await channelContext()
    const overrides = await formatOverrides()
    const rows = (data ?? [])
      .filter((v) => passesSubFilter(v, chans, subs))
      .map((v) => ({ ...v, format: effectiveFormat(v, overrides) }))
      .filter((v) => format === 'all' || v.format === format)
      .map((v) => ({ ...v, ...deriveMetrics(v, chans.get(v.channel_id), trends.get(v.channel_id)) }))

    // 발굴점수의 침투력 항을 체급 백분위로 갈아끼운다 (정렬 기준이라 줄 세우기 전에)
    rescoreByTier(rows)

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
    let q = supabase
      .from('yt_videos')
      .select('*')
      .in('channel_id', ids)
      .gte('published_at', since)
      .gte('score', 0)
      .order('published_at', { ascending: false })
      .limit(300)
    q = excludePicked(q, req, await pickColumnsReady())

    const { data, error } = await q
    if (error) throw error

    const { chans, trends } = await channelContext()
    const overrides = await formatOverrides()
    const all = (data ?? [])
      .filter((v) => passesSubFilter(v, chans, subs))
      .map((v) => ({ ...v, format: effectiveFormat(v, overrides) }))
      .filter((v) => format === 'all' || v.format === format)
      .map((v) => ({ ...v, ...deriveMetrics(v, chans.get(v.channel_id), trends.get(v.channel_id)) }))

    rescoreByTier(all)

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

// 설정 토글은 전부 같은 모양이다 (yt_watches 의 setting 행 하나)
const SETTING_FLAGS = {
  trending: { value: 'trending_on', label: '급상승 수집' },
  prospect: { value: 'prospect_on', label: '새 광맥 자동 탐사' },
  // 기본이 on 이라 '꺼 두었다' 는 사실을 행으로 남긴다 (다른 토글과 반대)
  hotWeekly: { value: 'hot_weekly_off', label: 'HOT 주간 탐사 끔', inverted: true }
}

// 설정 행은 yt_watches 에 type='setting' 으로 들어간다. 그런데 초기 스키마의
// type 체크 제약에 'setting' 이 빠져 있어 저장이 막힌다(그래서 급상승 토글도 안 먹었다).
// 제약을 넓히는 SQL 은 TODO-SQL.md 0-E 에 있다.
const SETTING_BLOCKED = '설정을 저장할 수 없어요. TODO-SQL.md 0-E 의 SQL(yt_watches ' +
  'type 제약에 setting 추가)을 먼저 실행해 주세요'

const isTypeCheckError = (err) => /type_check/i.test(err?.message ?? '')

async function toggleSetting(name, on) {
  const flag = SETTING_FLAGS[name]
  if (!flag) throw new Error('알 수 없는 설정이에요')
  // inverted 인 설정은 '켜기' 가 곧 행을 지우는 것이다
  if (flag.inverted) on = !on
  if (on) {
    const { error } = await supabase
      .from('yt_watches')
      .insert({ type: 'setting', value: flag.value, label: flag.label, active: true })
    if (error) throw isTypeCheckError(error) ? new Error(SETTING_BLOCKED) : error
  } else {
    const { error } = await supabase
      .from('yt_watches').delete().eq('type', 'setting').eq('value', flag.value)
    if (error) throw error
  }
  return readSettings()
}

app.post('/api/settings/trending', requireAuth, async (req, res) => {
  try {
    res.json(await toggleSetting('trending', req.body?.on))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 새 광맥 탐사 자동 실행 (키워드 검색 = 1건당 100유닛). 기본 off.
app.post('/api/settings/prospect', requireAuth, async (req, res) => {
  try {
    res.json(await toggleSetting('prospect', req.body?.on))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 🔥 HOT 주간 탐사 (일요일 저녁). 기본 on.
app.post('/api/settings/hot-weekly', requireAuth, async (req, res) => {
  try {
    res.json(await toggleSetting('hotWeekly', req.body?.on))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 🔎 지금 탐사 — 키워드 감시를 이번 한 번만 돌린다 (자동이 꺼져 있어도)
app.post('/api/prospect', requireAuth, async (req, res) => {
  try {
    if (collecting) {
      return res.status(409).json({ error: '이미 수집이 돌고 있어요. 끝나면 화면이 갱신됩니다' })
    }
    const report = await collect({ prospect: true, only: 'prospect' })
    if (!sentQuotaAbort(res, report)) res.json(report)
  } catch (err) {
    sendYtError(res, err)
  }
})

// ---------------------------------------------------------------- 후보 관리함
//
// 0 = 없음 / 1 = ⭐ 후보 / 2 = ❤️ 확정.
// 담는 순간 발굴·신작 목록에서 빠져 같은 영상을 두 번 검토하지 않는다.
const PICK_LEVELS = [0, 1, 2]
const TARGETS = ['A', 'B', 'C', 'D', 'E']

// 용도는 출처 채널이 속한 그룹 이름으로 추정한다. 못 맞히면 null(미지정)로 두고
// 사용자가 칩으로 직접 고른다.
const TARGET_BY_GROUP = [
  [/시사|뉴스/, 'A'],
  [/쉬는\s*시간|잡학/, 'B'],
  [/지식\s*에세이|에세이/, 'D']
]

// 컬럼이 아직 없으면(SQL 미실행) 후보 기능만 조용히 비활성화한다.
// 이걸 안 걸면 pick_level 필터가 들어간 발굴·신작이 통째로 500 이 된다.
let pickReady = null

async function pickColumnsReady() {
  if (pickReady !== null) return pickReady
  const { error } = await supabase.from('yt_videos').select('pick_level, target_group').limit(1)
  pickReady = !error
  if (!pickReady) {
    console.warn(`[pick] 후보 컬럼이 아직 없습니다 (TODO-SQL.md 참고): ${error.message}`)
  }
  return pickReady
}

// ---------------------------------------------------------------- 댓글 수집
//
// 후보로 담은 영상(pick_level >= 1)만 대상이다. 발굴·신작 목록 전체의 댓글을 받으면
// 할당량이 남아나지 않는다. commentThreads.list 는 호출당 1유닛이라 영상 1건 = 1유닛이다.
// 답글은 세기만 하고 본문은 받지 않는다 (상위 댓글만으로 신호는 충분하다).
const COMMENT_MAX = 50        // 영상당 가져올 상위 댓글 수 (API 상한)
const COMMENT_REFRESH_D = 7   // 마지막 수집이 이보다 오래된 영상만 다시 받는다
const COMMENT_WEEKLY_CAP = 100 // 주간 갱신 한 번에 쓸 최대 유닛(= 영상 수)

let commentsReady = null

async function commentsTableReady() {
  if (commentsReady !== null) return commentsReady
  const { error } = await supabase.from('yt_comments').select('comment_id').limit(1)
  commentsReady = !error
  if (!commentsReady) {
    console.warn(`[comments] yt_comments 테이블이 아직 없습니다 (TODO-SQL.md 0-C 참고): ${error.message}`)
  }
  return commentsReady
}

async function fetchComments(videoId) {
  const data = await ytGet('commentThreads', {
    part: 'snippet',
    videoId,
    order: 'relevance',
    maxResults: COMMENT_MAX,
    textFormat: 'plainText'
  })
  addUnitsToday(1, 'comments')

  const now = new Date().toISOString()
  return (data.items ?? []).map((it) => {
    const top = it.snippet?.topLevelComment
    const s = top?.snippet ?? {}
    return {
      video_id: videoId,
      comment_id: top?.id ?? it.id,
      text: String(s.textOriginal ?? s.textDisplay ?? '').slice(0, 4000),
      like_count: Number(s.likeCount ?? 0),
      reply_count: Number(it.snippet?.totalReplyCount ?? 0),
      published_at: s.publishedAt ?? null,
      collected_at: now
    }
  }).filter((c) => c.comment_id)
}

// force 가 아니면 최근에 받아 온 영상은 건너뛴다.
// ⭐ 를 껐다 켰다 해도 유닛을 다시 쓰지 않게 하는 장치다.
async function collectCommentsFor(videoId, { force = false } = {}) {
  if (!(await commentsTableReady())) return { skipped: 'no-table', units: 0 }

  if (!force) {
    const { data } = await supabase
      .from('yt_comments').select('collected_at').eq('video_id', videoId)
      .order('collected_at', { ascending: false }).limit(1)
    const at = data?.[0]?.collected_at
    if (at && Date.now() - new Date(at).getTime() < COMMENT_REFRESH_D * DAY) {
      return { skipped: 'fresh', units: 0, at }
    }
  }

  let rows
  try {
    rows = await fetchComments(videoId)
  } catch (err) {
    // 댓글을 꺼 둔 영상은 흔하다. 수집 전체를 세우지 않고 로그만 남긴다.
    logFailure(`comments:${videoId}`, err)
    return { skipped: 'error', error: err.message, units: 1 }
  }
  if (rows.length === 0) return { saved: 0, units: 1 }

  // 같은 댓글이 쌓이지 않게 comment_id 로 충돌시킨다.
  // 충돌하면 좋아요·답글 수와 갱신 시각이 새 값으로 덮이고, 새 댓글만 줄이 늘어난다.
  const { error } = await supabase.from('yt_comments').upsert(rows, { onConflict: 'comment_id' })
  if (error) throw error
  return { saved: rows.length, units: 1 }
}

// ⭐ 를 누른 직후에 부른다. 픽 자체는 이미 성공했으므로 여기서 실패해도 조용히 넘긴다.
function queueComments(videoId) {
  collectCommentsFor(videoId).catch((err) => logFailure(`comments:${videoId}`, err))
}

// 주간 갱신 — 담아 둔 영상 중 마지막 수집이 오래된 것만. 한 번에 CAP 유닛까지.
async function refreshPickComments() {
  const report = { videos: 0, saved: 0, units: 0, fresh: 0, errors: 0, capped: false }
  if (!(await commentsTableReady()) || !(await pickColumnsReady())) return report

  const { data: picks, error } = await supabase
    .from('yt_videos').select('video_id').gte('pick_level', 1).limit(500)
  if (error) throw error

  for (const p of picks ?? []) {
    if (report.units >= COMMENT_WEEKLY_CAP) { report.capped = true; break }
    const r = await collectCommentsFor(p.video_id)
    report.units += r.units ?? 0
    if (r.skipped === 'fresh') report.fresh++
    else if (r.skipped === 'error') report.errors++
    else { report.videos++; report.saved += r.saved ?? 0 }
  }

  console.log(`[comments] 주간 갱신 — 영상 ${report.videos}건 · 댓글 ${report.saved}개 · ` +
    `${report.units}유닛 (최근 수집이라 건너뜀 ${report.fresh}건${report.capped ? ' · 상한 도달' : ''})`)
  return report
}

// 댓글에서 읽어 낼 신호. 여기 낱말만 고치면 요약 통계가 따라 바뀐다.
const REQUEST_SIGNALS = ['해주세요', '해 주세요', '알려주세요', '알려 주세요', '궁금']
const EMPATHY_SIGNALS = ['저도', '공감', '내 얘기', '내얘기']

const hasAny = (text, words) => words.some((w) => text.includes(w))

function commentStats(rows) {
  const top = rows[0] ?? null
  return {
    total: rows.length,
    requests: rows.filter((c) => hasAny(c.text ?? '', REQUEST_SIGNALS)).length,
    empathy: rows.filter((c) => hasAny(c.text ?? '', EMPATHY_SIGNALS)).length,
    top: top && { text: top.text, like_count: top.like_count },
    collected_at: rows.reduce((max, c) => (c.collected_at > max ? c.collected_at : max), '') || null
  }
}

// 개념 태그 컬럼은 따로 본다. 후보함 SQL(0-A)만 돌리고 이건 아직 안 돌렸을 수 있다.
let conceptReady = null

async function conceptColumnReady() {
  if (conceptReady !== null) return conceptReady
  const { error } = await supabase.from('yt_videos').select('concept_tags').limit(1)
  conceptReady = !error
  if (!conceptReady) {
    console.warn(`[pick] 개념 태그 컬럼이 아직 없습니다 (TODO-SQL.md 0-B 참고): ${error.message}`)
  }
  return conceptReady
}

const CONCEPT_MAX = 8   // 한 영상에 붙일 수 있는 태그 수
const CONCEPT_LEN = 24  // 태그 한 개의 글자 수

// 화면은 쉼표로 여러 개를 한 번에 보낸다. 공백·# 정리, 중복(대소문자 무시) 제거, 개수 제한.
function normalizeConceptTags(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(',')
  const out = []
  for (const t of raw) {
    const tag = String(t ?? '').replace(/[#\s]+/g, ' ').trim().slice(0, CONCEPT_LEN)
    if (!tag || out.some((x) => x.toLowerCase() === tag.toLowerCase())) continue
    out.push(tag)
    if (out.length >= CONCEPT_MAX) break
  }
  return out
}

let targetCache = { at: 0, map: new Map() }

// 채널 id -> 추정 용도. 그룹 편성은 자주 바뀌지 않으니 30분 캐시.
async function channelTargets() {
  if (targetCache.map.size > 0 && Date.now() - targetCache.at < 30 * 60e3) return targetCache.map

  const [groups, links, watches] = await Promise.all([
    supabase.from('yt_groups').select('id, name'),
    supabase.from('yt_watch_groups').select('watch_id, group_id'),
    supabase.from('yt_watches').select('id, value').eq('type', 'channel')
  ])

  const letterOf = new Map()
  for (const g of groups.data ?? []) {
    const hit = TARGET_BY_GROUP.find(([re]) => re.test(g.name ?? ''))
    if (hit) letterOf.set(g.id, hit[1])
  }

  // 한 채널이 여러 그룹에 속하면 먼저 걸리는 쪽을 쓴다
  const byWatch = new Map()
  for (const l of links.data ?? []) {
    const letter = letterOf.get(l.group_id)
    if (letter && !byWatch.has(l.watch_id)) byWatch.set(l.watch_id, letter)
  }

  const map = new Map()
  for (const w of watches.data ?? []) {
    const letter = byWatch.get(w.id)
    if (letter) map.set(w.value, letter)
  }
  targetCache = { at: Date.now(), map }
  return map
}

app.post('/api/pick', requireAuth, async (req, res) => {
  try {
    if (!(await pickColumnsReady())) {
      return res.status(503).json({
        error: '후보함 컬럼이 아직 없어요. TODO-SQL.md 의 SQL 을 먼저 실행해 주세요'
      })
    }

    const { video_id, level, target_group, concept_tags, excluded, kept } = req.body ?? {}
    if (!video_id) return res.status(400).json({ error: 'video_id 가 필요해요' })

    const patch = {}
    // 🤔 킵 — 검토 대기에서 빼되 버리지는 않는다. 킵 칸에서 언제든 승격·제외할 수 있다.
    if (kept !== undefined) {
      if (!(await keptColumnReady())) {
        return res.status(503).json({
          error: '킵 컬럼이 아직 없어요. TODO-SQL.md 0-G 의 SQL 을 먼저 실행해 주세요'
        })
      }
      patch.kept = !!kept
    }
    // 예심 통과분 제외 — 다시 올라오지 않게 표시하고 대기 칸에서 뺀다
    if (excluded !== undefined) {
      if (!(await auditionColumnsReady())) {
        return res.status(503).json({
          error: '예심 컬럼이 아직 없어요. TODO-SQL.md 0-F 의 SQL 을 먼저 실행해 주세요'
        })
      }
      patch.excluded = !!excluded
      patch.auto_picked = false
      if (await keptColumnReady()) patch.kept = false
    }
    if (concept_tags !== undefined) {
      if (!(await conceptColumnReady())) {
        return res.status(503).json({
          error: '개념 태그 컬럼이 아직 없어요. TODO-SQL.md 0-B 의 SQL 을 먼저 실행해 주세요'
        })
      }
      patch.concept_tags = normalizeConceptTags(concept_tags)
    }
    if (level !== undefined) {
      const lv = Number(level)
      if (!PICK_LEVELS.includes(lv)) return res.status(400).json({ error: '레벨을 확인해 주세요' })
      patch.pick_level = lv
      // 옛 starred 컬럼도 같이 맞춰 둔다 (이관 전 데이터와 섞이지 않게)
      patch.starred = lv >= 1
      patch.starred_at = lv >= 1 ? new Date().toISOString() : null
    }
    if (target_group !== undefined) {
      if (target_group !== null && !TARGETS.includes(target_group)) {
        return res.status(400).json({ error: '용도를 확인해 주세요' })
      }
      patch.target_group = target_group
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: '바꿀 내용이 없어요' })
    }

    // 처음 담을 때 용도가 비어 있으면 채워 준다.
    // 민감 주제면 채널 그룹 추정보다 우선해서 A(부계정)로 잡는다.
    if (patch.pick_level >= 1 && patch.target_group === undefined) {
      const { data: cur } = await supabase
        .from('yt_videos').select('channel_id, target_group, title').eq('video_id', video_id).single()
      if (cur && !cur.target_group) {
        const guess = sensitiveHits(cur.title).length > 0
          ? 'A'
          : (await channelTargets()).get(cur.channel_id)
        if (guess) patch.target_group = guess
      }
    }

    // 컬럼이 없는 상태에서 select 에 넣으면 통째로 에러가 난다
    const cols = 'video_id, pick_level, target_group, starred_at' +
      ((await conceptColumnReady()) ? ', concept_tags' : '') +
      ((await auditionColumnsReady()) ? ', auto_picked, excluded' : '')

    const { data, error } = await supabase
      .from('yt_videos').update(patch).eq('video_id', video_id)
      .select(cols).single()
    if (error) throw error

    // 담는 순간 댓글을 1회 받아 둔다. 응답을 붙잡지 않고 뒤에서 돈다.
    if (patch.pick_level >= 1) queueComments(video_id)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 옛 이름. 북마크나 캐시된 화면이 아직 부를 수 있어 남겨 둔다.
app.post('/api/star', requireAuth, async (req, res) => {
  try {
    const { video_id, starred } = req.body ?? {}
    if (!video_id) return res.status(400).json({ error: 'video_id 가 필요해요' })

    if (await pickColumnsReady()) {
      const { error } = await supabase
        .from('yt_videos')
        .update({
          pick_level: starred ? 1 : 0,
          starred: !!starred,
          starred_at: starred ? new Date().toISOString() : null
        })
        .eq('video_id', video_id)
      if (error) throw error
    } else {
      const { error } = await supabase
        .from('yt_videos')
        .update({ starred: !!starred, starred_at: starred ? new Date().toISOString() : null })
        .eq('video_id', video_id)
      if (error) throw error
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 🗂 후보함 — 담아 둔 것 전부. ❤️ 확정이 먼저, 그다음 담은 날짜 역순.
app.get('/api/picks', requireAuth, async (req, res) => {
  try {
    const ready = await pickColumnsReady()
    const { level = 'all', target = 'all' } = req.query

    let q = supabase.from('yt_videos').select('*')
    if (ready) {
      q = q.gte('pick_level', 1)
      if (level === '1' || level === '2') q = q.eq('pick_level', Number(level))
      if (target === 'none') q = q.is('target_group', null)
      else if (TARGETS.includes(target)) q = q.eq('target_group', target)
    } else {
      q = q.eq('starred', true) // 컬럼 이관 전에는 옛 즐겨찾기를 그대로 보여준다
    }

    const { data, error } = await q.order('starred_at', { ascending: false }).limit(300)
    if (error) throw error

    const { chans, trends } = await channelContext()
    const rows = rescoreByTier(
      (data ?? []).map((v) => ({
        ...v,
        pick_level: Number(v.pick_level ?? (v.starred ? 1 : 0)),
        ...deriveMetrics(v, chans.get(v.channel_id), trends.get(v.channel_id))
      }))
    ).sort((a, b) =>
      b.pick_level - a.pick_level ||
      new Date(b.starred_at ?? 0) - new Date(a.starred_at ?? 0))

    attachEvergreen(rows, await velocityMap(rows.map((v) => v.video_id)))
    await attachSaturation(rows)

    // 요약은 화면 필터와 무관하게 담아 둔 것 전체 기준으로 센다
    const summary = { total: 0, candidate: 0, confirmed: 0, by_target: { none: 0 } }
    for (const t of TARGETS) summary.by_target[t] = 0

    if (ready) {
      const { data: all } = await supabase
        .from('yt_videos').select('pick_level, target_group').gte('pick_level', 1).limit(2000)
      for (const r of all ?? []) {
        summary.total++
        if (Number(r.pick_level) >= 2) summary.confirmed++
        else summary.candidate++
        summary.by_target[r.target_group && TARGETS.includes(r.target_group) ? r.target_group : 'none']++
      }
    } else {
      summary.total = rows.length
      summary.candidate = rows.length
      summary.by_target.none = rows.length
    }

    // 🤖 예심 통과 — 기계가 걸러 놓고 사람 검토를 기다리는 것 (auto_picked & 아직 안 담김)
    let auto = []
    let sensitive = []
    let kept = []
    const auditionOn = await auditionColumnsReady()
    const keptOn = await keptColumnReady()

    if (auditionOn) {
      let q = supabase
        .from('yt_videos').select('*')
        .eq('excluded', false) // not null default false 라 이 비교로 충분하다
        .or('pick_level.is.null,pick_level.eq.0')
        .order('auto_picked_at', { ascending: false })
        .limit(150)
      // 킵도 예심에서 나온 것이라 auto_picked 는 그대로 두고 kept 로만 갈라 놓는다
      q = keptOn ? q.or('auto_picked.eq.true,kept.eq.true') : q.eq('auto_picked', true)

      const { data: pending } = await q
      const rows = rescoreByTier((pending ?? []).map((v) => ({
        ...v, ...deriveMetrics(v, chans.get(v.channel_id), trends.get(v.channel_id))
      })))
      attachGrades(rows)
      attachEvergreen(rows, await velocityMap(rows.map((v) => v.video_id)))
      await attachSaturation(rows)
      rows.sort((a, b) => b.dig_score - a.dig_score)

      // 🤔 킵 → 🅐 전용(민감 주제) → 일반 검토 대기 순으로 갈라 담는다
      for (const v of rows) {
        if (keptOn && v.kept) kept.push(v)
        else if (v.sensitive?.length > 0) sensitive.push(v)
        else auto.push(v)
      }
    }

    // 개념 태그 컬럼이 없으면 화면에서 입력칸 자체를 감춘다 (저장할 때 503 을 보느니)
    res.json({
      rows, auto, sensitive, kept, summary, ready,
      concept_ready: await conceptColumnReady(),
      audition_ready: auditionOn,
      kept_ready: keptOn
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 🔥 HOT — 세 칸. 감시망 안 데이터로 만드는 칸은 할당량을 쓰지 않는다.
app.get('/api/hot', requireAuth, async (req, res) => {
  try {
    const { chans, trends } = await channelContext()
    const overrides = await formatOverrides()
    const watched = await watchedChannelIds()
    const decorate = (v) => ({
      ...v,
      format: effectiveFormat(v, overrides),
      ...deriveMetrics(v, chans.get(v.channel_id), trends.get(v.channel_id))
    })

    // 1) 🔥 지금 뜨는 주제 — 최근 90일 중 배율·침투 상위 (감시망 안, 무료)
    const since = new Date(Date.now() - HOT.TRENDING_DAYS * DAY).toISOString()
    const { data: recent } = await supabase
      .from('yt_videos').select('*')
      .gte('published_at', since).gte('score', 0)
      .gte('multiple', HOT.TRENDING_MIN_MULT)
      .order('multiple', { ascending: false }).limit(300)

    const trending = rescoreByTier((recent ?? []).map(decorate))
    attachGrades(trending)
    trending.sort((a, b) => b.dig_score - a.dig_score)
    const trendingOut = hidePicked(trending, req).slice(0, HOT.TOP)

    // 2)·3) 탐사로 걸린 것들 (감시망 밖)
    const { data: found } = await supabase
      .from('yt_videos').select('*')
      .like('source', 'hot:%')
      .order('views', { ascending: false }).limit(500)
    const hot = (found ?? []).map(decorate)
      .filter((v) => !watched.has(v.channel_id))
      .filter((v) => HOT.FORMATS.includes(v.format))

    // 2) 📺 추천 채널 — 영상이 아니라 채널 단위로 묶는다
    const byChannel = new Map()
    for (const v of hot) {
      if (!v.channel_id) continue
      if (!byChannel.has(v.channel_id)) byChannel.set(v.channel_id, [])
      byChannel.get(v.channel_id).push(v)
    }
    const channels = [...byChannel.entries()].map(([id, vids]) => {
      const sorted = vids.sort((a, b) => Number(b.views ?? 0) - Number(a.views ?? 0))
      const subs = Number(chans.get(id)?.subscriber_count ?? 0)
      return {
        channel_id: id,
        channel_title: sorted[0].channel_title,
        subscriber_count: subs,
        reach: subs > 0 ? Number((Number(sorted[0].views ?? 0) / subs).toFixed(2)) : null,
        found: vids.length,
        global: sorted.some((v) => String(v.source).startsWith('hot:global')),
        hits: sorted.slice(0, 2).map((v) => ({
          video_id: v.video_id, title: v.title, views: Number(v.views ?? 0)
        }))
      }
    })
      .filter((c) => (c.reach ?? 0) >= HOT.OUTLIER_REACH ||
        Number(c.hits[0]?.views ?? 0) >= HOT.OUTLIER_VIEWS)
      .sort((a, b) => (b.reach ?? 0) - (a.reach ?? 0))
      .slice(0, HOT.TOP)

    // 3) 🌍 해외 광맥 — 아웃라이어만. 같은 주제를 국내에서 이미 몇 곳이 다뤘는지 붙인다.
    const globalRows = hot
      .filter((v) => String(v.source).startsWith('hot:global:'))
      .filter((v) => (v.reach ?? 0) >= HOT.OUTLIER_REACH ||
        Number(v.views ?? 0) >= HOT.OUTLIER_VIEWS)
      .map((v) => ({ ...v, hot_term: String(v.source).split(':')[2] ?? '' }))

    // 국내 커버리지는 '영상별' 이 아니라 '검색어별' 로 한 번만 잰다 (같은 말로 찾은 것들이라)
    const terms = [...new Set(globalRows.map((v) => v.hot_term).filter(Boolean))]
    const coverage = new Map()
    if (terms.length > 0) {
      const payload = terms.map((t) => ({ video_id: t, channel_id: null, keyword: t }))
      const { data: sat } = await supabase.rpc('topic_saturation', {
        payload, window_days: METRIC.SATURATION_WINDOW_D
      })
      for (const r of sat ?? []) coverage.set(r.video_id, Number(r.channels ?? 0))
    }
    for (const v of globalRows) v.kr_coverage = coverage.get(v.hot_term) ?? null

    // 국내에서 덜 다뤄진 것부터 (겹치지 않는 광맥이 먼저 보이게)
    globalRows.sort((a, b) =>
      (a.kr_coverage ?? 99) - (b.kr_coverage ?? 99) || Number(b.views ?? 0) - Number(a.views ?? 0))

    const lastHotAt = (found ?? []).reduce(
      (max, v) => (v.first_seen_at > max ? v.first_seen_at : max), '')

    res.json({
      trending: trendingOut,
      channels,
      global: hidePicked(globalRows, req).slice(0, HOT.TOP),
      last_prospect_at: lastHotAt || null,
      cost: hotCost(),
      pairs: HOT_KEYWORD_PAIRS.slice(0, HOT.EN_TERMS).map(([ko, en]) => ({ ko, en }))
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 🔥 지금 탐사 — 국내·해외 검색을 지금 돌린다 (비싸다: 검색 1건당 100유닛)
app.post('/api/hot/prospect', requireAuth, async (req, res) => {
  try {
    const { kr = true, global = true } = req.body ?? {}
    const report = await prospectHot({ kr, global })
    if (!sentQuotaAbort(res, report)) res.json(report)
  } catch (err) {
    sendYtError(res, err)
  }
})

// 🤖 예심 — 지금 기준으로 다시 돌린다. ?dry=1 이면 세어만 보고 DB 는 안 건드린다.
app.post('/api/audition', requireAuth, async (req, res) => {
  try {
    res.json(await runAudition({ dryRun: req.query.dry === '1' }))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 💬 댓글 — 담아 둔 영상의 상위 댓글. 좋아요순.
app.get('/api/comments', requireAuth, async (req, res) => {
  try {
    const { video_id } = req.query
    if (!video_id) return res.status(400).json({ error: 'video_id 가 필요해요' })

    if (!(await commentsTableReady())) {
      return res.json({ ready: false, rows: [], stats: null })
    }

    const { data, error } = await supabase
      .from('yt_comments').select('*').eq('video_id', video_id)
      .order('like_count', { ascending: false }).limit(200)
    if (error) throw error

    const rows = data ?? []
    res.json({ ready: true, rows, stats: commentStats(rows) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 💬 댓글 수동 수집 (1유닛). 담아 둔 영상만 받는다.
app.post('/api/comments/collect', requireAuth, async (req, res) => {
  try {
    const { video_id } = req.body ?? {}
    if (!video_id) return res.status(400).json({ error: 'video_id 가 필요해요' })

    if (!(await commentsTableReady())) {
      return res.status(503).json({
        error: '댓글 테이블이 아직 없어요. TODO-SQL.md 0-C 의 SQL 을 먼저 실행해 주세요'
      })
    }

    // 후보함 밖의 영상까지 받아 주면 할당량이 새어 나간다
    if (await pickColumnsReady()) {
      const { data: v } = await supabase
        .from('yt_videos').select('pick_level').eq('video_id', video_id).single()
      if (Number(v?.pick_level ?? 0) < 1) {
        return res.status(400).json({ error: '후보로 담은 영상만 댓글을 받아요 (★ 을 먼저 눌러 주세요)' })
      }
    }

    const r = await collectCommentsFor(video_id, { force: true })
    if (r.skipped === 'error') {
      const quota = /quota|429/i.test(r.error ?? '')
      return res.status(quota ? 429 : 502).json({
        error: quota
          ? `할당량이 바닥났어요. ${QUOTA_NOTE}`
          : `댓글을 받지 못했어요 (댓글이 꺼진 영상일 수 있어요): ${r.error}`,
        quota
      })
    }
    res.json(r)
  } catch (err) {
    sendYtError(res, err)
  }
})

// 옛 이름 — 배열만 돌려주던 시절의 호출을 위해 남겨 둔다
app.get('/api/starred', requireAuth, async (req, res) => {
  try {
    const ready = await pickColumnsReady()
    let q = supabase.from('yt_videos').select('*')
    q = ready ? q.gte('pick_level', 1) : q.eq('starred', true)

    const { data, error } = await q.order('starred_at', { ascending: false }).limit(200)
    if (error) throw error

    const { chans, trends } = await channelContext()
    const rows = rescoreByTier(
      (data ?? []).map((v) => ({ ...v, ...deriveMetrics(v, chans.get(v.channel_id), trends.get(v.channel_id)) }))
    )

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

  const { chans, trends } = await channelContext()
  const overrides = await formatOverrides()
  const decorate = (v) => ({
    ...v,
    format: effectiveFormat(v, overrides),
    ...deriveMetrics(v, chans.get(v.channel_id), trends.get(v.channel_id))
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
    topFresh = rescoreByTier((data ?? []).map(decorate))
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
  const newDigs = rescoreByTier((digs ?? []).map(decorate)).slice(0, METRIC.WEEKLY_DIG_MAX)

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
    const w = await weeklyReport()
    res.json({
      ...w,
      top_fresh: hidePicked(onlyWatched(w.top_fresh), req),
      new_digs: hidePicked(onlyWatched(w.new_digs), req)
    })
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
      const ready = await conceptColumnReady()
      const { data } = await supabase
        .from('yt_videos').select(ready ? 'title, concept_tags' : 'title')
        .eq('video_id', video_id).single()

      // 손으로 붙인 개념 태그가 제목에서 뽑은 낱말보다 정확하다. 있으면 먼저 쓴다.
      const tags = normalizeConceptTags(data?.concept_tags ?? [])
      const lower = new Set(tags.map((t) => t.toLowerCase()))
      const words = extractKeywords(data?.title)
      const fromTitle = words.length > 0 ? words : extractKeywords(data?.title, { loose: true })
      keywords = [...tags, ...fromTitle.filter((w) => !lower.has(w.toLowerCase()))]
    }

    if (keyword) {
      return res.json({ keyword, keywords, results: await relatedFromDb(keyword, video_id) })
    }

    // 변별력이 높은 낱말부터 시도하되, 0건이면 다음 후보로 넘어간다.
    // 빈 패널이 뜨는 것보다 낫다.
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
    addUnitsToday(units, 'yt-search')
    res.json({ keyword: term, saved, units, results: await relatedFromDb(term, video_id) })
  } catch (err) {
    sendYtError(res, err)
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

    res.json(hidePicked(onlyWatched(videos).map((v) => ({
      ...v,
      views: latest[v.video_id] ?? 0,
      hits: matchedKeywords(v.title, includeKws)
    })), req))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/tracking', requireAuth, async (req, res) => {
  try {
    res.json(hidePicked(onlyWatched(await buildTracking()), req))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/watches', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('yt_watches').select('*').order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ watches: data ?? [], lastRun, growth: await channelGrowth() })
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

// ---------------------------------------------------------------- 예상 사용량
//
// 지금 설정으로 하루에 몇 유닛을 쓰게 되는지 미리 보여 준다. 30분 캐시.
const CYCLES_PER_DAY = (COLLECT_CRON.split(' ')[1] ?? '').split(',').length || 1
let estimateCache = { at: 0, value: null }

async function estimateDailyUnits() {
  if (estimateCache.value && Date.now() - estimateCache.at < 30 * 60e3) return estimateCache.value

  const settings = await readSettings()
  const { data: watches } = await supabase
    .from('yt_watches').select('type, value').eq('active', true)
  const channels = (watches ?? []).filter((w) => w.type === 'channel')
  const keywords = (watches ?? []).filter((w) => w.type === 'keyword')

  // 백카탈로그가 남은 채널이 하나도 없으면 그 예산은 안 쓴다
  const done = await backfillDoneSet()
  const digging = channels.filter((c) => !done.has(c.value)).length

  const by = {
    // 채널 최신 업로드: playlistItems 1 + videos.list 1
    '채널 신작': channels.length * 2 * CYCLES_PER_DAY,
    '통계 갱신': REFRESH.UNIT_BUDGET * CYCLES_PER_DAY,
    '재생시간 백필': DURATION_UNIT_BUDGET * CYCLES_PER_DAY,
    '백카탈로그': digging > 0 ? BACKFILL_UNIT_BUDGET * CYCLES_PER_DAY : 0,
    '채널 정보': Math.ceil(channels.length / 50), // 하루 1회
    '급상승': settings.trendingOn ? CYCLES_PER_DAY : 0,
    '새 광맥 탐사': settings.prospectOn ? keywords.length * 101 * CYCLES_PER_DAY : 0
  }

  // 🔥 HOT 탐사도 주 1회라 하루치로 나눠 본다
  if (settings.hotWeeklyOn) by['HOT 주간 탐사'] = Math.ceil(hotCost() / 7)

  // 댓글은 주 1회라 하루치로 나눠 본다
  if (await commentsTableReady()) {
    let picks = 0
    if (await pickColumnsReady()) {
      const { count } = await supabase
        .from('yt_videos').select('video_id', { count: 'exact', head: true }).gte('pick_level', 1)
      picks = count ?? 0
    }
    by['댓글 수집'] = Math.ceil(Math.min(picks, COMMENT_WEEKLY_CAP) / 7)
  }

  const value = {
    total: Object.values(by).reduce((a, b) => a + b, 0),
    by,
    cycles_per_day: CYCLES_PER_DAY
  }
  estimateCache = { at: Date.now(), value }
  return value
}

// 상태바 — 마지막 수집·총 영상 수·오늘 쓴 할당량
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const { count } = await supabase
      .from('yt_videos').select('video_id', { count: 'exact', head: true })

    // 🤖 예심 통과 후 검토를 기다리는 건수 (발굴 탭 배지에 쓴다)
    let auditionPending = 0
    if (await auditionColumnsReady()) {
      let q = supabase
        .from('yt_videos').select('video_id', { count: 'exact', head: true })
        .eq('auto_picked', true).eq('excluded', false)
        .or('pick_level.is.null,pick_level.eq.0')
      // 킵해 둔 것은 '검토 대기' 가 아니다
      if (await keptColumnReady()) q = q.eq('kept', false)
      const { count: n } = await q
      auditionPending = n ?? 0
    }

    // DB 장부가 있으면 인스턴스 전부를 합산한 값, 없으면 이 인스턴스의 파일값
    const local = readUnitsFile()
    const shared = await unitsTodayFromDb()
    const { units, by } = shared ?? local

    res.json({
      collecting,
      units_shared: !!shared, // false 면 이 인스턴스에서 쓴 것만 센 값이다
      units_by: by ?? {},
      // 댓글 수집은 영상 1건당 1유닛이라 얼마나 먹었는지 따로 보인다
      comment_units_today: Number(by?.comments) || 0,
      quota_note: QUOTA_NOTE,
      audition_pending: auditionPending,
      estimate: await estimateDailyUnits(),
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
    addUnitsToday(r.units, 'channels')
    res.json(r)
  } catch (err) {
    sendYtError(res, err)
  }
})

app.post('/api/collect', requireAuth, async (req, res) => {
  try {
    if (collecting) {
      return res.status(409).json({ error: '이미 수집이 돌고 있어요. 끝나면 화면이 갱신됩니다' })
    }
    const report = await collect()
    if (!sentQuotaAbort(res, report)) res.json(report)
  } catch (err) {
    sendYtError(res, err)
  }
})

app.use(express.static(path.join(__dirname, 'public')))

// 재시작할 때마다 수집을 돌리면 배포 한 번에 한 사이클씩 태운다.
// 다른 인스턴스가 방금 돌았는지 할당량 장부로 확인하고, 최근이면 건너뛴다.
async function shouldCollectOnBoot() {
  if (!(await quotaTableReady())) return true // 장부가 없으면 판단할 수 없다
  const since = new Date(Date.now() - BOOT_COLLECT_GAP_H * 3600e3).toISOString()
  const { data, error } = await supabase
    .from('yt_quota_log').select('id').eq('source', 'collect').gte('used_at', since).limit(1)
  if (error) return true
  return (data ?? []).length === 0
}

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`)

  // 시작 시 1회 — 단, 최근 ${BOOT_COLLECT_GAP_H}시간 안에 누가 이미 돌았으면 건너뛴다
  shouldCollectOnBoot()
    .then((go) => {
      if (!go) {
        console.log(`[collect] 최근 ${BOOT_COLLECT_GAP_H}시간 안에 수집 기록이 있어 시작 수집을 건너뜁니다`)
        return
      }
      return collect()
    })
    .catch((err) => console.error('[collect] 초기 실행 실패:', err.message))

  // 정규 수집 — 하루 2회 (한국시간 06:00 / 21:00)
  cron.schedule(COLLECT_CRON, () => {
    collect().catch((err) => console.error('[collect] 예약 실행 실패:', err.message))
  }, { timezone: COLLECT_TZ })

  // 담아 둔 영상의 댓글은 주 1회만 갱신한다 (월요일 04:00, 영상 1건당 1유닛)
  cron.schedule('0 4 * * 1', () => {
    refreshPickComments().catch((err) => console.error('[comments] 주간 갱신 실패:', err.message))
  }, { timezone: COLLECT_TZ })

  // 🔥 HOT 탐사 — 일요일 저녁 한 번 (기본 on, 감시 관리에서 끌 수 있다)
  cron.schedule(HOT_CRON, async () => {
    try {
      const { hotWeeklyOn } = await readSettings()
      if (!hotWeeklyOn) return console.log('[hot] 주간 탐사가 꺼져 있어 건너뜁니다')
      await prospectHot()
    } catch (err) {
      console.error('[hot] 주간 탐사 실패:', err.message)
    }
  }, { timezone: COLLECT_TZ })
})
