# TODO — Supabase SQL

밤샘 작업(`night-work` 브랜치)에서 **코드만 올리고 DB 는 건드리지 않았습니다.**
아래를 Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요.

실행 전에도 서버는 죽지 않습니다. 해당 기능만 조용히 비어 있습니다.

**⚠️ 실행 대기 4건** — `0-B. 개념 태그` · `0-C. 댓글 수집` · `0-D. 할당량 합산` ·
`0-E. 설정 행 허용`. 나머지는 전부 실행 완료됐습니다.
문서는 무엇을 왜 넣었는지 남겨 두려고 그대로 둡니다.

---

## 0-B. 🏷 개념 태그 (v1.4) — ⚠️ **실행 대기**

후보함 행에 손으로 붙이는 주제어입니다. 제목에서 기계적으로 뽑은 낱말보다 정확해서,
`🔎 관련` 탐색이 **태그가 있으면 태그를 먼저** 검색어로 씁니다.

```sql
-- 개념 태그: 후보함에서 손으로 붙이는 주제어 (없으면 null)
alter table public.yt_videos add column if not exists concept_tags text[];

-- 태그로 거슬러 찾을 때를 위한 인덱스 (배열 포함 검색)
create index if not exists yt_videos_concept_tags_gin
  on public.yt_videos using gin (concept_tags);
```

### 실행하면 이렇게 동작합니다

| 항목 | 동작 |
|---|---|
| 태그 입력 | 후보함(⭐ 이상) 행의 제목 아래 입력칸. **쉼표로 여러 개**를 한 번에 |
| 저장 시점 | `Enter` 또는 입력칸 밖을 누를 때 (`POST /api/pick` 의 `concept_tags`) |
| 정리 규칙 | 앞뒤 공백·`#` 제거, 대소문자 무시 중복 제거, **태그당 24자·영상당 8개**까지 |
| 태그 칩 누르기 | 그 태그로 `🔎 관련` 탐색 |
| `×` | 그 태그만 빼기 |
| `🔎 관련` | 태그가 있으면 태그 순서대로 먼저 시도, 없으면 기존 낱말 추출 |
| `[아이디어로]` 복사 | `[D] 제목 \| URL \| #고독 #쇼펜하우어` |

- 상수는 `server.js` 의 `CONCEPT_MAX`(8) · `CONCEPT_LEN`(24) 에서 고칩니다.
- 실행 전에는 **입력칸이 아예 안 보입니다**(`GET /api/picks` 가 `concept_ready: false`).
  그 상태로 저장을 시도하면 503 으로 안내합니다. 다른 기능은 정상입니다.
- `upsert_videos` 는 갱신할 컬럼을 명시하는 함수라 **수집이 돌아도 태그는 보존**됩니다.

### 되돌리려면

```sql
drop index if exists public.yt_videos_concept_tags_gin;
alter table public.yt_videos drop column if exists concept_tags;
```

---

## 0-A. 🗂 후보 관리함 (v1.3) — ✅ 실행 완료

**상태: ✅ 실행·동작 확인 (2026-08-17).** 기존 즐겨찾기 7건이 ⭐ 후보로 이관됐고,
`GET /api/picks` 가 `ready: true` 로 응답합니다. 실측한 동작:

| 확인 항목 | 결과 |
|---|---|
| ⭐ 담기 (`level=1`) | `pick_level=1` + 출처 채널 그룹으로 용도 `D` 자동 추정 ✓ |
| 용도 태그 수동 지정 | `D` → `C` 로 교체 ✓ |
| ❤️ 확정 (`level=2`) | `pick_level=2`, 요약 `confirmed` 에 반영 ✓ |
| 잘못된 용도값 (`Z`) | 400 으로 거부 ✓ (`yt_videos_target_group_check`) |
| 후보에서 빼기 (`level=0`) | `pick_level=0` · `starred_at=null` 로 원복 ✓ |
| 발굴 목록에서 제외 | 44건 중 담긴 것 0건 ✓ |
| ⭐ 포함 보기 (`?picked=1`) | 45건, 그중 담긴 것 7건 ✓ |

```sql
-- 픽 레벨: 0 없음 / 1 ⭐ 후보 / 2 ❤️ 확정
alter table public.yt_videos add column if not exists pick_level int not null default 0;

-- 용도 태그: A~E 또는 null(미지정)
alter table public.yt_videos add column if not exists target_group text;

alter table public.yt_videos drop constraint if exists yt_videos_target_group_check;
alter table public.yt_videos add constraint yt_videos_target_group_check
  check (target_group is null or target_group in ('A','B','C','D','E'));

-- 기존 즐겨찾기(starred=true)를 ⭐ 후보로 이관
update public.yt_videos
   set pick_level = 1
 where starred = true and coalesce(pick_level, 0) = 0;

-- 후보함 정렬(❤️ 먼저, 그다음 담은 날짜 역순)과 목록에서 담긴 것 제외용
create index if not exists yt_videos_pick_idx
  on public.yt_videos (pick_level, starred_at desc);
```

### 실행하면 이렇게 동작합니다

| 항목 | 동작 |
|---|---|
| 발굴·신작에서 ★ | `pick_level = 1` 로 담고 **그 자리에서 목록에서 사라집니다** (낙관적 업데이트) |
| ⭐ 포함 보기 | 각 탭 상단 토글. 켜면 담아 둔 것도 함께 보입니다 (기본 off) |
| 후보함 | `pick_level >= 1` 전부. ❤️ 확정이 먼저, 그다음 담은 날짜 역순 |
| ⭐ / ❤️ | ❤️ 를 다시 누르면 ⭐ 로 내려가고, ⭐ 를 다시 누르면 후보에서 빠집니다 |
| 용도 태그 | 행마다 A~E 칩. 켜진 것을 다시 누르면 미지정 |
| 용도 자동 추정 | 처음 담을 때 출처 채널의 그룹 이름으로 채웁니다 — `시사/뉴스`→**A**, `쉬는시간/잡학`→**B**, `지식에세이/에세이`→**D**, 그 외 null |
| `[아이디어로]` 복사 | 용도가 있으면 `[D] 제목 \| URL` 형식 |

- 담은 시각은 기존 `starred_at` 을 그대로 씁니다(컬럼을 늘리지 않으려고). `starred` 도
  `pick_level >= 1` 과 항상 같이 갱신되므로, 이관 후에도 옛 화면이 깨지지 않습니다.
- `upsert_videos` 는 갱신할 컬럼을 명시하는 함수라 **수집이 돌아도 두 컬럼은 보존**됩니다.

### 되돌리려면

```sql
alter table public.yt_videos drop column if exists pick_level;
alter table public.yt_videos drop column if exists target_group;
```

---

## 0-C. 💬 댓글 수집 (v1.5) — ⚠️ **실행 대기**

후보로 담은 영상(`pick_level >= 1`)의 **상위 댓글만** 모읍니다. 목록 전체의 댓글을 받으면
할당량이 남아나지 않습니다. `commentThreads.list` 는 호출당 1유닛이라 **영상 1건 = 1유닛**입니다.

```sql
create table if not exists public.yt_comments (
  video_id text not null references public.yt_videos(video_id) on delete cascade,
  comment_id text primary key,
  text text,
  like_count int not null default 0,
  reply_count int not null default 0,
  published_at timestamptz,
  collected_at timestamptz not null default now()
);

-- 패널이 늘 '이 영상의 좋아요순' 으로 읽는다
create index if not exists yt_comments_video_likes_idx
  on public.yt_comments (video_id, like_count desc);

-- 서버(서비스 키)만 접근한다. 정책을 만들지 않으므로 anon 키로는 한 줄도 보이지 않는다.
alter table public.yt_comments enable row level security;
```

> 다른 표(`yt_videos` 등)는 `disable row level security` 로 두었는데 이 표만 `enable` 입니다.
> 서비스 키는 RLS 를 우회하므로 서버 동작은 같고, 혹시 anon 키가 새어도 댓글은 안 열립니다.

### 실행하면 이렇게 동작합니다

| 항목 | 동작 |
|---|---|
| 수집 대상 | `pick_level >= 1` 인 영상만 |
| 무엇을 | `commentThreads.list` · `order=relevance` · `maxResults=50` 의 **상위 댓글** (답글은 개수만) |
| 언제 (자동) | ⭐ 담는 순간 1회 + **주 1회 갱신**(월요일 04:00, 한 번에 최대 100유닛) |
| 언제 (수동) | 댓글 패널의 `↻ 갱신 (1유닛)` |
| 다시 받으면 | `comment_id` 충돌 → **좋아요·답글 수와 갱신 시각만** 새로 쓰고, 새 댓글만 줄이 늘어납니다 |
| 최근 수집분 | 마지막 수집이 7일 이내면 건너뜁니다 (⭐ 를 껐다 켜도 유닛을 또 쓰지 않게) |
| 댓글이 꺼진 영상 | 403 이 와도 수집 전체를 세우지 않고 `logs/collect-*.log` 에만 남깁니다 |

상수는 `server.js` 의 `COMMENT_MAX`(50) · `COMMENT_REFRESH_D`(7) · `COMMENT_WEEKLY_CAP`(100).

### 되돌리려면

```sql
drop table if exists public.yt_comments;
```

---

## 0-D. ⚡ 할당량 합산 장부 (v1.6) — ⚠️ **실행 대기**

같은 API 키를 **Railway·집·학교**에서 같이 씁니다. 인스턴스마다 자기 파일
(`logs/units-*.json`)만 보면 "오늘 얼마 썼나" 가 늘 실제보다 적게 나옵니다.
쓴 만큼 DB 에 한 줄씩 남기고, 상태바는 **태평양 날짜 기준으로 전부 합산**해 보여 줍니다.

```sql
create table if not exists public.yt_quota_log (
  id bigserial primary key,
  units int not null,
  source text,
  used_at timestamptz not null default now()
);

-- 상태바가 늘 '태평양 오늘' 구간만 훑는다
create index if not exists yt_quota_log_used_idx
  on public.yt_quota_log (used_at desc);

-- 서버(서비스 키)만 접근. 정책 없음.
alter table public.yt_quota_log enable row level security;
```

### 실행하면 이렇게 동작합니다

| 항목 | 동작 |
|---|---|
| 기록 시점 | 유닛을 쓸 때마다 한 줄 (`collect` · `channels` · `comments` · `yt-search` · `channel-search` · `channel-lookup`) |
| 상태바 | `⚡ 오늘` 이 **모든 인스턴스 합산값**으로 바뀝니다 |
| 테이블이 없으면 | 지금처럼 이 서버의 파일값만 쓰고, 옆에 `(이 서버만)` 이 붙습니다 |
| 툴팁 | 어디에 얼마를 썼는지 + 합산 범위 + 리셋 안내 |
| 할당량 초과(403) | 응답이 **429** 로 바뀌고 문구에 "구글 프로젝트 전체 기준 · 태평양 자정(한국 오후 4~5시경) 리셋" 이 붙습니다 |

- 파일 기록(`logs/units-*.json`)도 그대로 남습니다. DB 가 안 될 때의 참고치입니다.
- 태평양 하루 경계는 서머타임 전환일까지 정확히 맞춥니다(`pacificDayStart`).
- 줄이 계속 쌓이므로 가끔 비우려면:
  `delete from public.yt_quota_log where used_at < now() - interval '90 days';`

### 되돌리려면

```sql
drop table if exists public.yt_quota_log;
```

---

## 0-E. ⚙️ 설정 행 허용 (v1.7) — ⚠️ **실행 대기 · 이거 없으면 토글이 안 먹습니다**

화면의 켜기/끄기 설정(급상승 수집, 새 광맥 자동 탐사)과 '백카탈로그 완료' 표시는
`yt_watches` 에 `type='setting'` 행으로 저장합니다. 그런데 **초기 스키마의 체크 제약에
`setting` 이 빠져 있어** 저장이 거부됩니다. 지금까지 급상승 토글이 켜지지 않던 이유입니다.

```sql
alter table public.yt_watches drop constraint if exists yt_watches_type_check;
alter table public.yt_watches add constraint yt_watches_type_check
  check (type in ('keyword', 'channel', 'include_kw', 'exclude_kw', 'category', 'setting'));
```

실행 전에는 이렇게 동작합니다.

| 기능 | 실행 전 | 실행 후 |
|---|---|---|
| 🔥 급상승 수집 토글 | 저장 실패 안내(항상 off) | 정상 |
| ⛏ 새 광맥 자동 탐사 토글 | 저장 실패 안내(항상 off · `🔎 지금 탐사` 버튼은 동작) | 정상 |
| 백카탈로그 완료 채널 제외 | 표시가 안 남아 다음 회차에 또 훑음 (영상 500개 상한에 걸린 채널은 그대로 제외) | 끝까지 훑은 채널도 순회에서 빠짐 |

---

## 0. ✅ 에버그린·포화도 함수 — 실행 완료

**상태: ✅ 실행·동작 확인 (2026-08-17).** 서버를 다시 띄워 확인한 결과 `[metric] ... 실패`
경고가 사라졌습니다. 수집도 `errors: []` 로 완주했습니다(영상 600건, 배율 7,416건 갱신).

**에버그린 (`video_velocity`) — 값이 나옵니다.**

| 탭 | 측정됨 | `측정 중` |
|---|---|---|
| 💎 발굴 | 7 / 44 | 37 |
| 🆕 신작 | 58 / 80 | 22 |

남은 `측정 중` 은 함수 문제가 아니라 **스냅샷이 1개뿐인 백카탈로그 영상**입니다(아래 각주 참고).
신작이 58/80 으로 이미 대부분 찬 것이 함수가 제대로 도는 증거입니다.

**포화도 (`topic_saturation`) — 함수는 정상, 다만 실제 화면 값은 전부 0 입니다.**

함수 자체는 잘 셉니다. 낱말을 직접 넣어 부른 결과:

```
keyword="이유" -> 18개 채널   keyword="사람" -> 16개 채널
keyword="역사" ->  3개 채널   keyword="지식" ->  1개 채널
```

그런데 `saturationMap()` 이 넘기는 핵심어는 `extractKeywords(title)[0]`, 즉
**2어절 명사구**(`"당신이 몰랐던"`, `"무섭도록 잘"`)입니다. 이 정도로 긴 구를 제목에
그대로 쓰는 다른 채널은 거의 없어서, 감시 중인 24채널 기준으로 124건 전부 0 이 나옵니다.
(`"당신이 몰랐던"` 은 1개 채널이 걸리는데 그게 출처 채널 자신이라 자기 제외 후 0.)

→ **DB 는 더 손댈 게 없습니다.** 포화도 칩을 실제로 띄우려면 `server.js` 의
`saturationMap()` 에서 구 대신 낱말을 고르도록 바꾸는 코드 수정이 필요합니다(별건).

> **2026-08-17 해결.** `extractKeywords()` 가 2어절 구 대신 개별 명사를 뽑고,
> `saturationMap()` 이 변별력 상위 2개 낱말을 각각 세어 최댓값을 쓰도록 고쳤습니다.
> 발굴 탭 44건 중 **28건이 0 이 아닌 포화도**로 나옵니다(0 → 16건, 1 이상 → 28건).

```sql
-- (1) 최근 증가량 — 스냅샷을 PostgREST 로 긁으면 1000행 상한에 잘려 값이 틀린다
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

-- (2) 주제 포화도 — 영상마다 ilike 를 던지면 80건에 80왕복이라 묶어서 한 번에
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
             and v.title ilike '%' ||
                 replace(replace(replace(x.keyword, '\', '\\'), '%', '\%'), '_', '\_')
                 || '%')
    from jsonb_to_recordset(payload)
      as x(video_id text, channel_id text, keyword text)
   where length(coalesce(x.keyword, '')) >= 2;
$$;
```

> 예고한 대로 **발굴 탭은 실행 후에도 37/44 가 `측정 중`** 입니다. 백카탈로그로 들어온
> 과거 영상은 스냅샷이 1개뿐이라 증가량을 낼 수 없어서입니다(README 1-j 하단 참고).
> 신작·모아보기 탭은 두 번째 스냅샷이 쌓이는 대로 값이 찹니다(신작은 이미 58/80).

---

## 1. 구독자 수 일별 이력 (v1.2 · 주간 구독 증가)

**상태: ✅ 실행 완료 확인** — 2026-08-17 강제 갱신으로 23개 채널 1일차 기록 완료.
7일치가 차면 `주간 구독 +N` 이 뜹니다(현재는 `측정 중`).

`yt_channels` 에는 구독자 **최신값만** 남고 갱신할 때마다 덮어써집니다.
추이를 보려면 따로 쌓아야 합니다.

```sql
create table if not exists public.yt_channel_snapshots (
  id bigserial primary key,
  channel_id text not null,
  subscriber_count bigint default 0,
  captured_at timestamptz default now()
);

create index if not exists yt_channel_snapshots_idx
  on public.yt_channel_snapshots (channel_id, captured_at desc);

-- 서버(서비스 키)만 접근하므로 다른 테이블과 같은 규칙을 따른다
alter table public.yt_channel_snapshots disable row level security;
```

### 실행하면 이렇게 동작합니다

| 항목 | 동작 |
|---|---|
| 기록 시점 | `refreshChannels()` 안에서 구독자 수를 갱신할 때 함께 (하루 1회, `CHANNEL_TTL_H`) |
| 중복 방지 | 같은 날(UTC 자정 기준) 기록이 있으면 건너뜁니다. 강제 갱신을 여러 번 눌러도 하루 1건 |
| 표시 | `⚙️ 감시 관리` 채널 줄에 `주간 구독 +1.2천` 칩. 증가는 초록, 감소는 주황 |
| 7일 전까지 | 이력이 6일치 미만이면 `주간 구독 측정 중` 으로 표시 |
| 계산 | 최근 8일치 중 (가장 최근 − 가장 오래된) 값. 상수는 `server.js` 의 `GROWTH_WINDOW_D` |
| 할당량 | **추가 소모 없음.** 이미 부르던 `channels.list` 응답을 그대로 저장합니다 |

### 실행 안 하면

- 서버 로그에 `[channel] 구독자 이력 생략(테이블 없음?)` 이 한 줄 남습니다
- 감시 관리 화면에서 구독 증가 칩만 안 보입니다. 다른 기능은 전부 정상입니다

### 되돌리려면

```sql
drop table if exists public.yt_channel_snapshots;
```

---

## 참고 — 현재 DB 상태 (2026-08-17 SQL 실행 후 재기동 실측)

| 함수·테이블 | 상태 | 없으면 |
|---|---|---|
| `public.upsert_videos(payload)` | ✅ 정상 | 수집 자체가 실패 (필수) |
| `public.recompute_multiples()` | ✅ 정상 (배율 7,416건 갱신) | 배율이 없어 발굴 탭이 빈 화면 |
| `public.yt_channel_snapshots` | ✅ 생성됨 (23채널 1일차 기록) | 주간 구독 증가만 안 보임 |
| `public.video_velocity(...)` | ✅ 정상 (발굴 7/44 · 신작 58/80 측정) | 에버그린 `최근7일 +N` 이 항상 `측정 중` |
| `public.topic_saturation(...)` | ✅ 정상 (발굴 44건 중 28건 0 아님) | 주제 포화도 칩이 안 나옴 |
| `yt_videos.pick_level` · `target_group` | ✅ 생성됨 (즐겨찾기 7건 ⭐ 이관) | 후보함 잠김, `POST /api/pick` 503 |

**DB 쪽 미실행 항목은 남아 있지 않습니다.** 화면에 아직 안 채워진 값은 두 가지 이유뿐입니다.

1. 에버그린 `측정 중` — 스냅샷이 2개 쌓일 때까지 기다리면 됩니다 (시간 문제)
2. ~~포화도 칩 미표시 — `saturationMap()` 의 핵심어 선택 문제~~ → 2026-08-17 코드 수정 완료
