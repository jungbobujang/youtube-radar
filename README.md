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
Node 20.6 이상이 필요합니다 (`--env-file`, 전역 `fetch`).

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
| `GET  /api/discover` | 최근 2일 내 발견 영상, 조회수순 |
| `GET  /api/tracking` | 추적 중 영상 + 증가량 + 유형 뱃지 |
| `GET  /api/watches` | 감시 목록 + 최근 수집 결과 |
| `POST /api/watches` | 감시 추가 (채널은 URL/핸들에서 ID 추출) |
| `POST /api/watches/:id/toggle` | 켜기/끄기 |
| `DELETE /api/watches/:id` | 삭제 |
| `POST /api/collect` | 수동 수집 |
