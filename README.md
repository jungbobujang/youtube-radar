# 📡 유튜브 레이더 v0.1

인기 급상승 · 키워드 · 채널을 주기적으로 훑어 영상의 조회수 추이를 쌓고,
**단기(이슈) / 중기(유행) / 장기(스테디)** 로 성장 유형을 가려주는 단일 서버 앱입니다.

- Node.js (Express) 단일 프로세스 — 수집 스케줄러와 웹 대시보드가 한 서버에 있음
- 저장소는 Supabase (Postgres)
- 3시간마다 자동 수집 + 서버 시작 시 1회 즉시 수집

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

## 4. ⚠ API 할당량 주의

YouTube Data API v3 의 기본 할당량은 **하루 10,000 유닛**입니다.

| 호출 | 유닛 | 이 앱에서 |
|---|---|---|
| `videos.list` | 1 | 인기 급상승 1회 + 감시 결과 상세 |
| `search.list` | **100** | 감시 대상 1건당 1회 |

수집은 **3시간마다(하루 8회)** 돕니다. 따라서:

```
감시 대상 N개 × 100유닛 × 8회 = 하루 800N 유닛
```

- 감시 **10개** → 하루 약 8,000 유닛 (여유 없음)
- 감시 **5개** → 하루 약 4,000 유닛 (권장)

**감시 대상은 10개 이하로 유지하세요.** 이 안내는 대시보드의 `⚙️ 감시 관리` 화면에도
현재 활성 개수와 예상 소모량과 함께 표시됩니다.

할당량이 바닥나면 수집이 실패하지만 서버는 죽지 않고 다음 주기에 다시 시도합니다.
수집 주기를 늘리려면 `server.js` 의 `cron.schedule('0 */3 * * *', ...)` 을 고치세요.

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
```

| 엔드포인트 | 설명 |
|---|---|
| `GET  /api/session` | 쿠키 인증 상태 |
| `POST /api/login` | 접속 코드 확인, 30일 쿠키 발급 |
| `GET  /api/radar` | 30점 이상 영상, 점수순 + 걸린 키워드 |
| `GET  /api/discover` | 최근 2일 내 발견 영상, 조회수순 |
| `GET  /api/tracking` | 추적 중 영상 + 증가량 + 유형 뱃지 |
| `GET  /api/watches` | 감시 목록 + 최근 수집 결과 |
| `POST /api/watches` | 감시 추가 (채널은 URL/핸들에서 ID 추출) |
| `POST /api/watches/:id/toggle` | 켜기/끄기 |
| `DELETE /api/watches/:id` | 삭제 |
| `POST /api/collect` | 수동 수집 |

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

| 지표 | 식 |
|---|---|
| 침투력 | 조회수 / 구독자수 (1.0 초과 = 구독자 밖으로 확산) |
| 참여율 | (좋아요 + 댓글×3) / 조회수 × 100 (%) |
| 채널활력 | 최근 90일 조회수 중앙값 / 구독자수 |
| 발굴점수 | 배율 × 침투력 × (1 + 참여율/5) |

상수는 `server.js` 상단 `METRIC` 에서 조정합니다.
구독자 수는 `channels.list` 로 하루 1회 갱신합니다 (50개당 1유닛).
