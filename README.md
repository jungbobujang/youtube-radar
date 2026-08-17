# 📡 유튜브 레이더 v1.1

감시 채널의 과거 영상까지 파고들어 **채널 평소 성적 대비 몇 배로 터진 영상**을 찾아내고,
조회수 추이로 **단기(이슈) / 중기(유행) / 장기(스테디)** 를 가려주는 단일 서버 앱입니다.

- Node.js (Express) 단일 프로세스 — 수집 스케줄러와 웹 대시보드가 한 서버에 있음
- 저장소는 Supabase (Postgres)
- 3시간마다 자동 수집 + 서버 시작 시 1회 즉시 수집
- 화면 계산은 전부 DB 기반 — 탭을 열거나 필터를 바꿔도 **할당량을 쓰지 않습니다**

주요 화면: 💎 발굴 · ⭐ 모아보기 · 📡 신작 · 📊 주간 · 📈 추적 중 · ⚙️ 감시 관리

---

## 1. DB 준비

Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요.

```sql
-- 감시 대상 (키워드 / 채널)
create table if not exists public.yt_watches (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('keyword', 'channel')),
  value text not null,
  label text,
  active boolean not null default true,
  created_at timestamptz default now()
);

-- 발견된 영상
create table if not exists public.yt_videos (
  video_id text primary key,
  title text not null,
  channel_id text,
  channel_title text,
  published_at timestamptz,
  source text,
  first_seen_at timestamptz default now()
);

-- 조회수 스냅샷 (수집할 때마다 한 줄씩 쌓임)
create table if not exists public.yt_snapshots (
  id bigserial primary key,
  video_id text not null references public.yt_videos(video_id) on delete cascade,
  views bigint default 0,
  likes bigint default 0,
  comments bigint default 0,
  captured_at timestamptz default now()
);

create index if not exists yt_snapshots_video_idx on public.yt_snapshots (video_id, captured_at desc);
create index if not exists yt_videos_seen_idx on public.yt_videos (first_seen_at desc);

-- 서버(서비스 키)만 접근하므로 RLS 는 켜지 않는다
alter table public.yt_watches disable row level security;
alter table public.yt_videos disable row level security;
alter table public.yt_snapshots disable row level security;
```

### 1-b. 관심사 필터링 (v0.2 추가분)

이미 위 테이블을 만든 상태라면 아래만 추가로 실행하세요.

```sql
-- 영상에 카테고리와 점수를 기록
alter table public.yt_videos add column if not exists category_id text;
alter table public.yt_videos add column if not exists score int default 0;

-- 감시 타입에 채점용 3종 추가
alter table public.yt_watches drop constraint if exists yt_watches_type_check;
alter table public.yt_watches add constraint yt_watches_type_check
  check (type in ('keyword','channel','include_kw','exclude_kw','category'));
```

기본 관심사 시드 (원하는 것만 골라 실행):

```sql
insert into public.yt_watches (type, value, label, active) values
  ('include_kw', '자기계발', '자기계발', true),
  ('include_kw', '운동',     '운동',     true),
  ('include_kw', '습관',     '습관',     true),
  ('include_kw', '외모',     '외모',     true),
  ('include_kw', '공부법',   '공부법',   true),
  ('include_kw', '뇌과학',   '뇌과학',   true),
  ('include_kw', '심리',     '심리',     true),
  ('include_kw', 'AI',       'AI',       true),
  ('exclude_kw', 'MV',       'MV',       true),
  ('exclude_kw', '예고편',   '예고편',   true),
  ('exclude_kw', '먹방',     '먹방',     true),
  ('exclude_kw', '직캠',     '직캠',     true);
```

### 1-c. 백카탈로그 발굴 모드 (v0.3 추가분)

```sql
-- 영상 최신 통계 (스냅샷 전수 조회 없이 정렬·중앙값 계산을 하기 위함)
alter table public.yt_videos add column if not exists views bigint default 0;
alter table public.yt_videos add column if not exists like_count bigint default 0;
alter table public.yt_videos add column if not exists comment_count bigint default 0;

-- 채널 중앙값 대비 배율
alter table public.yt_videos add column if not exists multiple numeric;

-- 발굴 정렬·필터용 인덱스
create index if not exists yt_videos_multiple_idx on public.yt_videos (multiple desc);
create index if not exists yt_videos_channel_idx on public.yt_videos (channel_id);
create index if not exists yt_videos_published_idx on public.yt_videos (published_at desc);
```

배율 계산은 DB 함수로 합니다. 행마다 값이 달라 PostgREST 로는 한 번에 쓸 수 없고,
upsert 로 우회하면 `NOT NULL` 제약(title 등)에 걸립니다.

```sql
create or replace function public.recompute_multiples()
returns integer
language plpgsql
as $$
declare
  affected integer := 0;
begin
  with med as (
    select channel_id,
           percentile_cont(0.5) within group (order by views) as m
    from public.yt_videos
    where channel_id is not null and views is not null
    group by channel_id
    having count(*) >= 5
  )
  update public.yt_videos v
     set multiple = round((v.views::numeric / med.m)::numeric, 2)
    from med
   where v.channel_id = med.channel_id
     and med.m > 0;
  get diagnostics affected = row_count;
  return affected;
end;
$$;
```

급상승 수집 on/off 는 `yt_watches` 에 `type='setting', value='trending_on'` 행이 있으면 켜짐,
없으면 꺼짐입니다. 별도 테이블 없이 감시 관리 화면의 체크박스로 조작합니다.

**수집 흐름**

1. 급상승 (설정이 켜져 있을 때만, 1유닛)
2. 신작 — 채널마다 업로드 재생목록 최근 25개 (채널당 2유닛)
3. 백카탈로그 — 저장량이 적은 채널부터 유닛 예산(`BACKFILL_UNIT_BUDGET`) 안에서
   과거를 파고든다. 채널당 최대 `BACKFILL_MAX_PER_CHANNEL`(500)개.
   이미 저장된 영상은 상세를 다시 부르지 않고, 스냅샷은 신작 수집에서 계속 쌓인다
4. 채널별 조회수 중앙값을 구해 각 영상의 `multiple`(배율) 갱신 (표본 5개 미만이면 건너뜀)

### 채점 규칙

| 항목 | 점수 |
|---|---|
| 제목에 관심 키워드(`include_kw`) 포함 | 개수 × **+30** |
| 감시 채널(`channel`)에서 발견 | **+40** |
| 감시 키워드(`keyword`) 검색 결과 | **+30** |
| 제외 키워드(`exclude_kw`)가 제목에 포함 | **−999** |
| 카테고리 필터가 있는데 급상승 영상이 그 밖이면 | **−999** |

- `🎯 내 레이더` 탭은 **30점 이상**만 점수순으로 보여줍니다.
- 점수가 **음수인 영상도 DB 에는 그대로 저장**됩니다. 추이 데이터를 잃지 않기 위해서이고,
  화면에서만 감춥니다. 나중에 관심사를 바꾸면 과거 데이터가 그대로 살아납니다.
- 관심/제외 키워드와 카테고리 필터는 **API 를 추가로 부르지 않습니다.** 할당량과 무관합니다.

> 서비스 키는 RLS 를 우회합니다. 접근 통제는 `ACCESS_CODE` 게이트가 담당하므로
> **서비스 키를 브라우저로 내보내면 안 됩니다.** 이 앱은 서버에서만 사용합니다.

---

## 2. 로컬 실행

```bash
npm install
cp .env.example .env    # 값 채우기
npm run dev             # node --env-file=.env server.js
```

http://localhost:3000 → 접속 코드 입력

`npm start` 는 `.env` 를 읽지 않습니다(배포용). 로컬에서는 `npm run dev` 를 쓰세요.
**Node 22 이상이 필요합니다.** `--env-file` 과 전역 `fetch` 는 20.6 부터 쓸 수 있지만,
`@supabase/supabase-js` 가 전역 `WebSocket` 을 찾기 때문에 22 미만에서는
`native WebSocket not found` 로 실행이 실패합니다. `package.json` 의 `engines` 로 못박아 뒀습니다.

### 환경변수

| 이름 | 설명 |
|---|---|
| `YT_API_KEY` | YouTube Data API v3 키 (Google Cloud Console) |
| `SUPABASE_URL` | `https://<project-id>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service_role 키 (서버 전용, 절대 공개 금지) |
| `ACCESS_CODE` | 대시보드 접속 코드 |
| `PORT` | 기본 3000 (Railway 는 자동 주입) |

---

## 3. Railway 배포

1. GitHub 저장소를 Railway 에 연결 (New Project → Deploy from GitHub repo)
2. Variables 탭에서 환경변수 **4개** 등록:
   - `YT_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `ACCESS_CODE`
   - (`PORT` 는 Railway 가 자동으로 넣어주므로 등록하지 않아도 됩니다)
3. Deploy → Settings 에서 도메인 생성

빌드 설정은 따로 필요 없습니다. Railway 가 `npm install` 후 `npm start` 를 실행합니다.

---

## 4. ⚠ API 할당량 — 실측 기준

YouTube Data API v3 의 기본 할당량은 **하루 10,000 유닛**입니다.
초기 문서에는 "감시 대상 1건당 100유닛"으로 적혀 있었지만, 채널 수집이
**업로드 재생목록 방식**으로 바뀐 뒤로는 실제 소모가 전혀 다릅니다.

### 호출별 단가

| 호출 | 유닛 | 이 앱에서 쓰는 곳 |
|---|---|---|
| `playlistItems.list` | 1 | 채널 신작·백카탈로그 (한 페이지 50개) |
| `videos.list` | 1 | 영상 상세 (한 번에 50개까지, `contentDetails` 붙여도 1) |
| `channels.list` | 1 | 채널 구독자 갱신(50개당 1), 업로드 재생목록 ID 최초 1회 |
| `search.list` | **100** | 키워드 감시, `유튜브 전체에서 찾기` 버튼 |

### 1회 수집 실측

| 단계 | 유닛 | 비고 |
|---|---|---|
| 급상승 | 1 | 꺼져 있으면 0 (기본 off) |
| 채널 신작 | 채널당 **2** | 재생목록 1 + 상세 1 (최초 1회만 채널조회 +1) |
| 키워드 감시 | 건당 **101** | search 100 + 상세 1 |
| 백카탈로그 | 최대 **260** | `BACKFILL_UNIT_BUDGET` 상한 |
| 재생시간 백필 | 최대 **20** | `DURATION_UNIT_BUDGET` 상한 |
| 채널 정보 갱신 | 채널 50개당 **1** | 하루 1회 (`CHANNEL_TTL_H`) |

**실측: 채널 20개 + 백카탈로그 포함 1회 302유닛 → 하루 8회 약 2,416유닛.**
백카탈로그가 다 차면(채널당 500개) 그 단계가 0에 수렴해 **회당 40유닛대**로 떨어집니다.

- 키워드 감시 **1개** = 하루 808유닛. 채널 감시 40개와 맞먹습니다.
- 위험한 쪽은 채널 수가 아니라 **키워드 개수**입니다. 3개를 넘기지 마세요.
- 같은 안내가 대시보드 `⚙️ 감시 관리` 상단에도 현재 개수와 함께 표시됩니다.

### 바닥났을 때

`quotaExceeded` / `dailyLimitExceeded` / `rateLimitExceeded` / HTTP 429 를 받으면
**그 사이클을 즉시 접습니다.** 뒤 단계도 같은 오류를 받을 뿐이라 재시도는 시간 낭비입니다.
서버는 죽지 않고 다음 cron(3시간 뒤)에 정상 복귀하며, 화면의 최근 수집 줄에
`할당량 초과로 중단` 이 표시됩니다.

- 5xx·네트워크 오류만 **3회까지 재시도**(0.8초, 1.6초)합니다. 4xx 는 즉시 포기합니다.
- 수동 수집과 cron 이 겹치면 뒤 호출을 **409 로 거절**합니다 (중복 실행 = 할당량 이중 소모).
- 실패는 DB 가 아니라 `logs/collect-YYYY-MM-DD.log` 에 한 줄 JSON 으로 쌓입니다.

수집 주기를 바꾸려면 `server.js` 의 `cron.schedule('0 */3 * * *', ...)` 을 고치세요.

---

## 5. 성장 유형 판별 기준

스냅샷이 **2개 미만이면 `수집 중`** 으로 표시됩니다 (추이를 계산할 수 없음).
최소 2회 수집(약 3시간)이 지나야 유형이 잡힙니다.

| 유형 | 조건 |
|---|---|
| 단기 (이슈) | 게시 3일 이내 + 최근 24시간 증가율이 일평균의 **2배 초과** |
| 장기 (스테디) | 게시 7일 이후 + 최근 24시간 증가율이 일평균의 **80% 이상** 유지 |
| 중기 (유행) | 위 둘에 해당하지 않는 나머지 |

배수(2배, 80%)는 `server.js` 의 `classify()` 에서 조정할 수 있습니다.

---

## 6. 구조

```
server.js           수집(cron) + API + 정적 서빙
public/index.html   대시보드 (단일 파일, 빌드 없음)
logs/               수집 실패 로그·할당량 장부 (자동 생성 · git 추적 안 함)
```

대시보드는 폭에 따라 세 가지로 접힙니다. 실측 결과는 `MOBILE-CHECK.md` 참고.

| 폭 | 레이아웃 |
|---|---|
| ~640px | 영상 행 2줄 (썸네일+제목 / 지표+버튼), 필터·지표 가로 스크롤, 감시 관리 카드형 |
| ~768px | 터치 영역 44px, 버튼은 아이콘만(라벨은 `title` 에) |
| 769px~ | 데스크톱 1줄 레이아웃 |

| 엔드포인트 | 설명 |
|---|---|
| `GET  /api/session` | 쿠키 인증 상태 |
| `POST /api/login` | 접속 코드 확인, 30일 쿠키 발급 |
| `GET  /api/dig` | 💎 발굴 — 배율 높은 과거 영상 (기간·그룹·채널·구독자·형식·정렬) |
| `GET  /api/fresh` | 📡 신작 — 감시 채널의 최근 30일 영상 |
| `GET  /api/weekly` | 📊 주간 — 지난 7일 요약 JSON (수동 조회, cron 미등록) |
| `GET  /api/picks` | 🗂 후보함 목록 + 용도별 요약 (`level`, `target` 필터) |
| `POST /api/pick` | 픽 레벨(0/1/2)·용도 태그 지정 |
| `GET  /api/starred` · `POST /api/star` | 옛 이름 (픽 레벨로 매핑해 그대로 동작) |
| `GET  /api/related` | 🔎 관련 주제 — DB 안에서만 (할당량 0) |
| `POST /api/related/search` | 🔎 관련 주제 — 유튜브 전체 검색 (100유닛) |
| `GET  /api/radar` | 30점 이상 영상, 점수순 + 걸린 키워드 |
| `GET  /api/discover` | 최근 2일 내 발견 영상, 조회수순 |
| `GET  /api/tracking` | 추적 중 영상 + 증가량 + 유형 뱃지 |
| `GET  /api/groups` · `POST` · `PATCH /:id` · `DELETE /:id` | 채널 그룹 CRUD |
| `POST /api/watch-groups` | 채널 ↔ 그룹 연결 토글 |
| `GET  /api/settings` | 그룹·채널 목록 + 급상승 on/off |
| `GET  /api/status` | 상태바 — 마지막 수집·총 영상 수·오늘 쓴 유닛 |
| `GET  /api/watches` | 감시 목록 + 최근 수집 결과 + 채널별 주간 구독 증가 |
| `POST /api/watches` | 감시 추가 (채널은 URL/핸들에서 ID 추출) |
| `PATCH /api/watches/:id` | 채널 형식 오버라이드 |
| `POST /api/watches/:id/toggle` | 켜기/끄기 |
| `DELETE /api/watches/:id` | 삭제 |
| `POST /api/channels/refresh` | 구독자·중앙값 강제 갱신 |
| `POST /api/collect` | 수동 수집 (이미 돌고 있으면 409) |

### 🗂 후보 관리함

훑기(발굴·신작)와 고르기(후보함)를 분리합니다. **담는 순간 목록에서 빠지므로**
같은 영상을 두 번 검토하지 않습니다.

| 픽 레벨 | 뜻 | 표시 |
|---|---|---|
| 0 | 담지 않음 | 발굴·신작 목록에 남아 있음 |
| 1 | 후보 | ⭐ · 후보함에 들어감 |
| 2 | 확정 | ❤️ · 후보함 맨 위 |

- 발굴·신작에서 **★ 을 누르면 그 자리에서 사라집니다**(낙관적 업데이트 — 실패하면 되돌아오고
  오류 메시지가 뜹니다). 상단 **`⭐ 포함 보기`** 토글을 켜면 담아 둔 것도 함께 보입니다(기본 off).
- 후보함에서 ❤️ 를 다시 누르면 ⭐ 로 내려가고, ⭐ 를 다시 누르면 후보에서 빠집니다.
- 정렬은 **❤️ 확정 먼저, 그다음 담은 날짜 역순**입니다.

#### 용도 태그 A~E

행마다 A~E 칩이 붙습니다. 켜진 칩을 다시 누르면 미지정으로 돌아갑니다.
처음 담을 때 **출처 채널의 그룹 이름으로 자동 추정**해 채웁니다.

| 그룹 이름에 들어간 말 | 용도 |
|---|---|
| 시사 · 뉴스 | **A** |
| 쉬는시간 · 잡학 | **B** |
| 지식에세이 · 에세이 | **D** |
| 그 외 | 미지정(null) |

매핑은 `server.js` 의 `TARGET_BY_GROUP` 에서 고칩니다. 후보함 상단에 용도별 개수가
요약으로 뜨고, 그 칩으로 필터도 겁니다. `[아이디어로]` 복사는 용도가 있으면
`[D] 제목 | URL` 형식으로 나갑니다.

> 컬럼 추가 SQL 은 `TODO-SQL.md` **0-A** 에 있습니다. 실행 전에는 후보함이 옛 즐겨찾기를
> 그대로 보여주고, 픽 변경은 503 으로 안내합니다. 나머지 기능은 정상입니다.

### 상태바

상단에 항상 붙어 있는 한 줄입니다. `/api/status` 를 60초마다(수집 중에는 5초마다) 읽습니다.

| 칸 | 내용 |
|---|---|
| ⏱ 마지막 수집 | 시각. 수집이 도는 중이면 점멸하는 `수집 중...` 으로 바뀝니다 |
| 🎞 영상 | `yt_videos` 총 행 수 |
| ⚡ 오늘 | 오늘 쓴 유닛 / 10,000 + 사용률 막대 (70% 주황, 90% 빨강) |

오늘 쓴 유닛은 **DB 가 아니라 `logs/units-YYYY-MM-DD.json`** 에 적힙니다.
할당량 리셋이 **태평양 자정** 기준이라 파일도 그 날짜로 끊습니다.
수집·채널 갱신·`유튜브 전체에서 찾기`·채널 추가(검색 폴백)가 모두 여기에 합산됩니다.
서버를 재시작해도 남지만, **YouTube 가 세는 값이 아니라 이 앱이 센 값**이므로 참고치입니다.

발굴 탭의 `⬇️ CSV` 는 서버를 다시 부르지 않고 **화면에 그려진 목록 그대로**
내보냅니다(제목·채널·조회수·배율·침투·참여·게시일·URL). 엑셀 한글 깨짐 방지로
BOM 을 붙이고, `=`·`+`·`-`·`@` 로 시작하는 제목은 수식으로 실행되지 않게 막습니다.

---

## 7. 지표 정의

모든 지표는 **수집된 DB 만으로** 계산합니다. 화면을 열 때 API 를 부르지 않습니다.

| 지표 | 식 | 읽는 법 |
|---|---|---|
| **배율** | 조회수 ÷ (같은 채널·같은 형식의 최근 조회수 중앙값) | 3배 = 그 채널 평소의 3배로 터짐 |
| **침투력** | 조회수 ÷ 구독자수 | 1.0 초과 = 구독자 밖으로 퍼진 영상<br>**등급은 같은 체급 내 상대평가** |
| **참여율** | (좋아요 + 댓글 × `COMMENT_WEIGHT`) ÷ 조회수 × 100 (%) | 조회수 대비 반응의 양 |
| **발굴점수** | `log(1+배율) × 침투력_체급백분위 × (1 + 참여율 / ENGAGE_DIVISOR)` | 발굴 탭 기본 정렬 |
| **채널활력** | **최근 90일 조회수 중앙값 ÷ 그 이전 90일 조회수 중앙값** | 0.5 미만 ⚠️ 쇠락 · 1.5 이상 📈 상승 |
| **에버그린** | 일평균 = 조회수 ÷ 게시 후 경과일<br>최근 증가량 = 최신 스냅샷 − 7일 전 근처 스냅샷 | 아직도 도는 영상인지 |
| **토론성** | 댓글 ÷ 좋아요 ≥ `DEBATE_RATIO` | 🗣️ 반응이 말로 나오는 주제 |
| **주제 포화도** | 그 핵심어를 최근 90일에 다룬 **다른 채널 수** | ✅ 공백 / ⚠️ 경쟁 |

### 체급 보정 — 구독자 구간

침투력은 **구독자 수에 직접 매인 지표**입니다. 100만 채널의 침투력 0.5 와
1만 채널의 0.5 는 전혀 다른 사건인데 한 줄로 세우면 큰 채널이 늘 아래에 깔립니다.
그래서 침투력은 **같은 체급 안에서만** 비교합니다.
(활력은 자기 과거와의 비교라 채널 크기와 무관합니다 — 아래 별도 절 참고.)

| 체급 | 구독자 |
|---|---|
| `t1` | ~5만 |
| `t2` | 5~30만 |
| `t3` | 30~100만 |
| `t4` | 100만+ |

체급이 바꾸는 것은 둘입니다. **숫자 자체는 보정하지 않고 그대로 표시합니다.**

| 대상 | 보정 방식 |
|---|---|
| 침투력 등급 | 전체가 아니라 **같은 체급 안에서** 상위 25% / 중간 / 하위 25% |
| 발굴점수 | `log(1+침투력)` 대신 **체급 내 백분위(0~1)** 를 곱한다. 최하위도 `REACH_PCT_FLOOR`(0.25) 만큼은 인정해 점수가 통째로 0 이 되지 않게 한다 |

- 체급 표본이 `GRADE_MIN_SAMPLE`(8)건 미만이면 그 체급은 등급을 비우고 숫자만 보여줍니다.
- 구독자 수를 아직 모르는 채널은 체급이 없어 등급에서 빠지고, 발굴점수에는 중립값(0.5)이 들어갑니다.
- 좌측 `구독자` 필터(전체 / ~5만 / 5~30만 / 30만+)는 **사용자가 고르는 범위**라 체급과 별개입니다.
  필터를 걸면 그 안에서 다시 체급이 나뉩니다.

### 채널 활력 — 자기 과거 대비

**활력 = 최근 90일 조회수 중앙값 ÷ 그 이전 90일 조회수 중앙값.**
구독자 수를 쓰지 않으므로 채널 크기와 무관합니다.

| 값 | 표시 |
|---|---|
| `< TREND_DECLINE`(0.5) | **⚠️ 쇠락** — 최근 성적이 반년 전의 절반도 안 된다 |
| `≥ TREND_RISE`(1.5) | **📈 상승** — 최근 성적이 반년 전의 1.5배 이상 |
| 그 사이 | 표시 없음 |
| 어느 한쪽 구간 영상이 `TREND_MIN_SAMPLE`(5)편 미만 | **판정 보류** — 표시 없음 |

이전 구간 중앙값이 0 이면 비율을 낼 수 없어 역시 판정 보류입니다.

> **왜 바꿨나** — 예전 정의는 `최근 90일 중앙값 ÷ 구독자수` 였습니다. 그 식은
> 방송사 아카이브 채널을 상시로 ⚠️ 로 만듭니다. `EBSDocumentary` 는 구독자 543만이라
> 무엇을 올려도 비율이 0.0033 이었지, 채널이 죽은 게 아니었습니다. 체급별 상대평가로
> 바꿔 봐도 EBS 는 자기 체급 중앙값의 1/33 이라 여전히 걸렸습니다.
> 자기 과거와 견주면 "요즘 성적이 떨어지고 있나" 라는 원래 물음에 그대로 답하면서
> 채널 크기에서 자유로워집니다.

계산은 180일치 영상을 한 번 훑어 채널별로 두 구간의 중앙값을 냅니다.
결과는 `TREND_TTL_MIN`(60분) 동안 메모리에 캐시하고, 수집이 끝나면 즉시 무효화합니다.
DB 컬럼을 쓰지 않으므로 **추가 SQL 이 필요 없습니다.**

### 등급 — Great / Normal / Low

배율·침투·참여 숫자 옆에는 **지금 보고 있는 목록의 분포 기준** 등급이 함께 붙습니다.

| 등급 | 기준 | 색 |
|---|---|---|
| **Great** | 그 지표 상위 25% (≥ p75) | 초록 |
| **Normal** | 중간 50% | 회색 |
| **Low** | 하위 25% (≤ p25) | 연빨강 |

> **침투력 등급만은 전체 분포가 아니라 같은 체급(구독자 구간) 안에서의 상대평가입니다.**
> 발굴 탭의 `침투` 뱃지에 마우스를 올리면 체급과 그 안에서의 순위가 나옵니다.
> 배율·참여율은 구독자 수와 무관한 지표라 전체 분포 그대로 봅니다.

- 절대 기준(예: "배율 3배 이상은 좋음")은 채널 성격에 따라 금방 무의미해집니다.
  그래서 고정 문턱값 대신 **분포**로 줄 세웁니다.
- 세 지표는 축이 다르므로 **각자의 분포로 따로** 판정합니다.
- 등급은 화면에 나가는 80건이 아니라 **필터를 통과한 후보 전체**로 계산합니다.
  (80건만 보면 분포가 좁아져 등급이 뭉갭니다)
- 표본이 **8건 미만**이면 사분위가 의미 없어 등급을 비우고 숫자만 보여줍니다.
- 적용 범위는 💎 발굴 · 📡 신작 탭입니다. ⭐ 모아보기와 📊 주간은 목록 성격상
  분포가 의미 없어 숫자만 나옵니다.

> **배율에 로그를 씌운 이유** — 배율과 침투력은 같은 방향으로 커집니다
> (구독자 대비 조회수가 폭발하는 채널). 곱을 그대로 쓰면 점수가 제곱으로 튀어
> 한 채널이 목록을 독점합니다. 로그로 완충하고, 그 위에 `PER_CHANNEL_CAP` 으로
> 한 채널의 노출 개수까지 제한합니다.

**배율은 형식별로 따로 계산합니다.** 쇼츠 조회수가 롱폼 중앙값을 왜곡하기 때문입니다.
표본이 5개 미만인 채널·형식은 배율을 내지 않습니다(빈 값).

상수는 전부 `server.js` 상단 `METRIC` 한 곳에 있습니다.

| 상수 | 기본값 | 뜻 |
|---|---|---|
| `ENGAGE_DIVISOR` | 5 | 참여율이 발굴점수에 기여하는 정도 (클수록 영향 작아짐) |
| `PER_CHANNEL_CAP` | 3 | 발굴 목록에서 한 채널이 차지할 수 있는 최대 개수 |
| `COMMENT_WEIGHT` | 3 | 댓글 1개를 좋아요 몇 개로 볼지 |
| `TREND_WINDOW_D` | 90 | 활력 한 구간 길이(일). 최근 N일 vs 그 이전 N일 |
| `TREND_MIN_SAMPLE` | 5 | 각 구간에 영상이 이만큼은 있어야 판정 |
| `TREND_DECLINE` | 0.5 | 이 아래면 ⚠️ 쇠락 |
| `TREND_RISE` | 1.5 | 이 위면 📈 상승 |
| `TREND_TTL_MIN` | 60 | 활력 계산 캐시 유지(분) |
| `REACH_PCT_FLOOR` | 0.25 | 발굴점수의 침투력 항 하한 |
| `HOT_ENGAGE_PCTL` | 0.75 | 참여율 상위 25% 에 💬 진한반응 |
| `CHANNEL_TTL_H` | 24 | 구독자 수 갱신 주기(시간) |
| `MEDIAN_WINDOW_D` | 90 | 채널활력용 최근 N일 |
| `DEBATE_RATIO` | 0.15 | 🗣️ 토론형 기준 |
| `VELOCITY_WINDOW_D` | 7 | 에버그린 증가량 창(일) |
| `SATURATION_WINDOW_D` | 90 | 포화도를 볼 최근 N일 |
| `SATURATION_WARN` | 2 | 다른 채널 이만큼부터 ⚠️ |
| `WEEKLY_TOP` / `WEEKLY_DIG_MIN` / `WEEKLY_DIG_MAX` | 10 / 5 / 20 | 주간 리포트 상위 개수·최소 배율·발굴 최대 개수 |

### 📊 주간 리포트

`/api/weekly` 는 지난 7일을 세 덩어리로 묶어 돌려줍니다. **cron 에 걸지 않습니다** —
탭을 열 때만 계산하고, DB 만 읽으므로 할당량을 쓰지 않습니다.

| 항목 | 기준 |
|---|---|
| 신작 성과 상위 10 | 감시 채널의 최근 7일 **게시분**, 배율순(동률이면 조회수) |
| 새로 발굴된 배율 5배+ | 최근 7일 **`first_seen_at`** 기준 — 발굴 대상은 과거 영상이라 "이번 주에 눈에 띈" 것을 본다 |
| 즐겨찾기 | 전체 수 + 이번 주 추가분(`starred_at`) |

---

## 8. 그룹 체계

채널을 주제별로 묶어 발굴·신작 탭에서 한 번에 걸러 보기 위한 장치입니다.

- `yt_groups` (그룹) ↔ `yt_watch_groups` (연결) ↔ `yt_watches` (채널) — **다대다**입니다.
  한 채널이 여러 그룹에 동시에 속할 수 있고, 그때는 각 그룹 섹션에 모두 나옵니다.
- 그룹을 지워도 **채널은 남습니다.** 연결만 끊깁니다 (`on delete cascade`).
- 어느 그룹에도 안 든 채널은 `⚙️ 감시 관리` 의 **📂 미분류** 섹션에 모입니다.
- 그룹은 분류 전용입니다. **API 를 추가로 부르지 않아 할당량과 무관합니다.**

필터는 그룹 → 채널 → 구독자대 → 형식 순으로 좁혀집니다. 넷은 서로 독립이라
겹쳐 쓸 수 있습니다(예: `📁 자기계발` 그룹 + `~5만` 구독자 + `롱폼`).

| 필터 | 값 |
|---|---|
| 그룹 | 전체 / 사용자가 만든 그룹 |
| 채널 | 전체 / 개별 채널 (선택 시 `PER_CHANNEL_CAP` 해제) |
| 구독자 | 전체 / ~5만 / 5~30만 / 30만+ |
| 형식 | 롱폼(기본) / 미드(1~3분) / 쇼츠 / 전체 |

`format_override` 가 걸린 채널은 재생시간과 무관하게 그 형식으로 봅니다
(1분짜리를 정규 콘텐츠로 올리는 채널용).

### 주간 구독 증가

`⚙️ 감시 관리` 의 채널 줄에 `주간 구독 +1.2천` 칩이 붙습니다.

- `yt_channels` 에는 구독자 **최신값만** 남아 덮어써지므로, 추이는
  `yt_channel_snapshots` 에 **하루 1건씩** 따로 쌓습니다.
- 기록 시점은 구독자 갱신과 같습니다(`CHANNEL_TTL_H` = 24시간).
  같은 날 기록이 있으면 건너뛰므로 강제 갱신을 눌러도 하루 1건입니다.
- 최근 8일치 중 (가장 최근 − 가장 오래된) 값이며, 6일치가 안 차면 `측정 중` 입니다.
- 이미 부르던 `channels.list` 응답을 저장할 뿐이라 **할당량을 더 쓰지 않습니다.**
- ⚠️ **테이블 생성 SQL 은 `TODO-SQL.md` 에 있습니다.** 실행 전에는 칩만 안 보이고
  나머지 기능은 정상 동작합니다.

### 1-d. 발굴 지표 (v0.4 추가분)

```sql
create table if not exists public.yt_channels (
  channel_id text primary key,
  title text,
  subscriber_count bigint default 0,
  recent_median_views bigint default 0,
  updated_at timestamptz default now()
);
```

> 이 절은 v0.4 당시 기록입니다. **현재 식은 7장 「지표 정의」를 보세요.**
> 침투력 등급은 체급 상대평가로, 채널활력은 `최근 90일 ÷ 이전 90일` 로 바뀌었고,
> 발굴점수의 침투력 항은 체급 내 백분위로 바뀌었습니다.

| 지표 | 식 (v0.4 당시) |
|---|---|
| 침투력 | 조회수 / 구독자수 (1.0 초과 = 구독자 밖으로 확산) |
| 참여율 | (좋아요 + 댓글×3) / 조회수 × 100 (%) |
| 채널활력 | 최근 90일 조회수 중앙값 / 구독자수 |
| 발굴점수 | 배율 × 침투력 × (1 + 참여율/5) |

상수는 `server.js` 상단 `METRIC` 에서 조정합니다.
구독자 수는 `channels.list` 로 하루 1회 갱신합니다 (50개당 1유닛).
`yt_channels.recent_median_views` 는 지금도 갱신되지만 활력 계산에는 쓰이지 않습니다
(활력은 `yt_videos` 를 직접 훑어 두 구간 중앙값을 냅니다).

### 1-e. 즐겨찾기·관련 탐색 (v0.5 추가분)

```sql
alter table public.yt_videos add column if not exists starred boolean default false;
alter table public.yt_videos add column if not exists starred_at timestamptz;
create index if not exists yt_videos_starred_idx on public.yt_videos (starred, starred_at desc);
```

관련 주제 탐색은 기본적으로 **DB 안에서만** 찾습니다(할당량 0).
`유튜브 전체에서 찾기` 를 누를 때만 `search.list` 1회(100유닛)를 씁니다.

### 1-f. 채널 그룹 (v0.6 추가분)

```sql
create table if not exists public.yt_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icon text default '📁',
  position int default 0
);

create table if not exists public.yt_watch_groups (
  watch_id uuid not null references public.yt_watches(id) on delete cascade,
  group_id uuid not null references public.yt_groups(id) on delete cascade,
  primary key (watch_id, group_id)
);

alter table public.yt_groups enable row level security;
alter table public.yt_watch_groups enable row level security;
```

채널은 여러 그룹에 동시에 속할 수 있습니다. 그룹을 지워도 채널은 남고 연결만 끊깁니다.

### 1-g. 영상 저장 함수 (v0.7)

PostgREST 의 upsert 는 페이로드에 없는 컬럼을 기본값으로 되돌립니다.
그대로 두면 수집이 돌 때마다 `starred` / `starred_at` / `multiple` 이 사라집니다.
갱신할 컬럼을 명시한 함수로 저장합니다.

```sql
create or replace function public.upsert_videos(payload jsonb)
returns integer
language plpgsql
as $$
declare n integer;
begin
  insert into public.yt_videos as v (
    video_id, title, channel_id, channel_title, published_at,
    category_id, views, like_count, comment_count, score, source
  )
  select
    x.video_id, x.title, x.channel_id, x.channel_title, x.published_at,
    x.category_id, x.views, x.like_count, x.comment_count, x.score, x.source
  from jsonb_to_recordset(payload) as x(
    video_id text, title text, channel_id text, channel_title text,
    published_at timestamptz, category_id text, views bigint,
    like_count bigint, comment_count bigint, score int, source text
  )
  on conflict (video_id) do update set
    title         = excluded.title,
    channel_title = excluded.channel_title,
    published_at  = excluded.published_at,
    category_id   = excluded.category_id,
    views         = excluded.views,
    like_count    = excluded.like_count,
    comment_count = excluded.comment_count,
    score         = excluded.score,
    source        = excluded.source;
  get diagnostics n = row_count;
  return n;
end;
$$;
```

`starred`, `starred_at`, `multiple`, `first_seen_at` 은 갱신 대상에서 빠져 보존됩니다.

### 1-h. 쇼츠/롱폼 구분 (v0.8)

```sql
alter table public.yt_videos add column if not exists duration_sec int;
create index if not exists yt_videos_duration_idx on public.yt_videos (duration_sec);
```

`upsert_videos` 를 duration_sec 까지 저장하도록 갱신합니다.

```sql
create or replace function public.upsert_videos(payload jsonb)
returns integer
language plpgsql
as $$
declare n integer;
begin
  insert into public.yt_videos as v (
    video_id, title, channel_id, channel_title, published_at,
    category_id, views, like_count, comment_count, duration_sec, score, source
  )
  select
    x.video_id, x.title, x.channel_id, x.channel_title, x.published_at,
    x.category_id, x.views, x.like_count, x.comment_count, x.duration_sec, x.score, x.source
  from jsonb_to_recordset(payload) as x(
    video_id text, title text, channel_id text, channel_title text,
    published_at timestamptz, category_id text, views bigint,
    like_count bigint, comment_count bigint, duration_sec int, score int, source text
  )
  on conflict (video_id) do update set
    title         = excluded.title,
    channel_title = excluded.channel_title,
    published_at  = excluded.published_at,
    category_id   = excluded.category_id,
    views         = excluded.views,
    like_count    = excluded.like_count,
    comment_count = excluded.comment_count,
    duration_sec  = coalesce(excluded.duration_sec, v.duration_sec),
    score         = excluded.score,
    source        = excluded.source;
  get diagnostics n = row_count;
  return n;
end;
$$;
```

배율 중앙값을 형식별로 나눠 계산합니다. 쇼츠 조회수가 롱폼 중앙값을 왜곡하지 않게 하기 위함입니다.

```sql
create or replace function public.recompute_multiples()
returns integer
language plpgsql
as $$
declare affected integer := 0;
begin
  with fmt as (
    select video_id, channel_id, views,
           case when duration_sec is null      then 'unknown'
                when duration_sec <= 60        then 'shorts'
                when duration_sec <= 180       then 'mid'
                else 'long' end as f
      from public.yt_videos
     where channel_id is not null and views is not null
  ),
  med as (
    select channel_id, f, percentile_cont(0.5) within group (order by views) as m
      from fmt
     group by channel_id, f
    having count(*) >= 5
  )
  update public.yt_videos v
     set multiple = round((v.views::numeric / med.m)::numeric, 2)
    from fmt, med
   where v.video_id   = fmt.video_id
     and med.channel_id = fmt.channel_id
     and med.f        = fmt.f
     and med.m > 0;
  get diagnostics affected = row_count;
  return affected;
end;
$$;
```

| 형식 | 기준 |
|---|---|
| shorts | 60초 이하 |
| mid | 61~180초 |
| long | 181초 이상 |

발굴·신작 탭의 기본값은 **롱폼**입니다. 재생시간이 아직 없는(`null`) 영상은
`형식 전체` 에서만 보입니다. 매 수집마다 예산(`DURATION_UNIT_BUDGET`) 안에서
50개씩 채워 넣습니다.

### 1-i. 채널 단위 형식 오버라이드 (v0.9)

```sql
alter table public.yt_watches add column if not exists format_override text
  check (format_override in ('long','shorts'));
```

`null` 이면 재생시간으로 자동 판별하고, 값이 있으면 길이와 무관하게 그 형식으로 봅니다.
1분짜리를 정규 콘텐츠로 올리는 채널처럼 길이로 갈리지 않는 경우를 위한 장치입니다.
`recompute_multiples` 도 이 오버라이드를 반영해 형식별 중앙값을 나눕니다.

### 1-j. 에버그린 · 토론성 · 주제 포화도 (v1.0)

지표 3종이 추가됩니다. **토론성은 SQL 없이 바로 동작**하고(이미 있는 컬럼만 씁니다),
**에버그린과 포화도는 아래 함수 2개가 필요**합니다. 함수가 없으면 서버는 죽지 않고
경고만 남긴 뒤 해당 지표를 비워 둡니다.

| 지표 | 식 | 표시 |
|---|---|---|
| 에버그린 | 일평균 = 조회수 / 게시 후 경과일<br>최근 증가량 = 최신 스냅샷 − 7일 전 근처 스냅샷 | `일평균 1.2천 · 최근7일 +3.4천` |
| 토론성 | 댓글 / 좋아요 ≥ `DEBATE_RATIO`(0.15) | 🗣️ 토론형 |
| 주제 포화도 | 핵심어를 최근 90일에 다룬 **다른 채널 수** | ✅ 최근 재탕 없음 / ⚠️ 최근 N개 채널이 다룸 |

스냅샷이 2개 미만이면 증가량을 낼 수 없어 `측정 중` 으로 표시됩니다(일평균은 나옵니다).
포화도는 1건일 때 아무것도 그리지 않습니다 — 우연일 수 있어 0건(공백)과 2건 이상(경쟁)만 신호로 봅니다.

**(1) 최근 증가량** — 스냅샷을 PostgREST 로 긁어오면 후보 수백 건 × 영상당 수십 행이
기본 1000행 상한에 조용히 잘려 증가량이 틀립니다. DB 안에서 계산합니다.

```sql
create or replace function public.video_velocity(ids text[], window_days int default 7)
returns table (
  video_id text, snaps int,
  latest_views bigint, latest_at timestamptz,
  prev_views bigint, prev_at timestamptz
)
language sql
stable
as $$
  with s as (
    select sn.video_id, sn.views, sn.captured_at
      from public.yt_snapshots sn
     where sn.video_id = any(ids)
  ),
  latest as (
    select distinct on (s.video_id) s.video_id, s.views, s.captured_at
      from s
     order by s.video_id, s.captured_at desc
  ),
  cnt as (
    select s.video_id, count(*)::int as n
      from s
     group by s.video_id
  ),
  prev as (
    -- 최신 스냅샷을 뺀 나머지 중 'N일 전' 에 시간상 가장 가까운 한 건
    select distinct on (s.video_id) s.video_id, s.views, s.captured_at
      from s
      join latest l on l.video_id = s.video_id
     where s.captured_at < l.captured_at
     order by s.video_id,
              abs(extract(epoch from
                (s.captured_at - (l.captured_at - make_interval(days => window_days)))))
  )
  select l.video_id, c.n, l.views, l.captured_at, p.views, p.captured_at
    from latest l
    join cnt c on c.video_id = l.video_id
    left join prev p on p.video_id = l.video_id;
$$;
```

**(2) 주제 포화도** — 영상마다 `ilike` 를 따로 던지면 80건에 80왕복입니다.
핵심어를 묶어 한 번에 넘깁니다.

```sql
create extension if not exists pg_trgm;
create index if not exists yt_videos_title_trgm
  on public.yt_videos using gin (title gin_trgm_ops);

create or replace function public.topic_saturation(payload jsonb, window_days int default 90)
returns table (video_id text, channels int)
language sql
stable
as $$
  select x.video_id,
         (select count(distinct v.channel_id)::int
            from public.yt_videos v
           where v.channel_id is not null
             and v.channel_id is distinct from x.channel_id
             and v.published_at >= now() - make_interval(days => window_days)
             and v.score >= 0
             -- 핵심어에 %, _ 가 섞여 들어오면(예: "199% 올리는") 와일드카드로 새니 막는다
             and v.title ilike '%' ||
                 replace(replace(replace(x.keyword, '\', '\\'), '%', '\%'), '_', '\_')
                 || '%')
    from jsonb_to_recordset(payload)
      as x(video_id text, channel_id text, keyword text)
   where length(coalesce(x.keyword, '')) >= 2;
$$;
```

`pg_trgm` 인덱스가 없어도 동작하지만, 영상이 쌓이면 `ilike` 전수 스캔이 느려집니다.

> **참고 — 발굴 탭의 '측정 중'**
> 백카탈로그로 들어온 과거 영상은 수집 때 스냅샷이 **1개만** 남습니다.
> 신작 수집(최근 25개)에 다시 걸리지 않는 한 두 번째 스냅샷이 쌓이지 않아
> 발굴 탭에서는 대부분 `측정 중` 으로 보입니다. 신작·모아보기 탭은 정상 동작합니다.
> 발굴 대상까지 추이를 보려면 수집 때 과거 영상 통계를 다시 읽는 단계가 따로 필요합니다
> (`videos.list` 50개당 1유닛).

상수는 `server.js` 상단 `METRIC` 에서 조정합니다
(`DEBATE_RATIO`, `VELOCITY_WINDOW_D`, `SATURATION_WINDOW_D`, `SATURATION_WARN`).
