# TODO — Supabase SQL

밤샘 작업(`night-work` 브랜치)에서 **코드만 올리고 DB 는 건드리지 않았습니다.**
아래를 Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요.

실행 전에도 서버는 죽지 않습니다. 해당 기능만 조용히 비어 있습니다.

---

## 0-A. 🗂 후보 관리함 (v1.3) — **실행 필요**

**상태: 미실행.** 실행 전에도 서버는 정상이고, 후보함은 옛 즐겨찾기를 그대로 보여줍니다
(⭐/❤️ 와 용도 태그만 잠깁니다. `POST /api/pick` 은 503 으로 안내를 돌려줍니다).

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

## 0. ⚠️ 에버그린·포화도 함수 — **미실행 확인됨**

서버를 띄워 확인한 결과, 아래 두 함수가 **DB 에 없습니다.** 실제 로그:

```
[metric] 최근 속도 계산 실패(함수 없음?): Could not find the function public.video_velocity(ids, window_days) in the schema cache
[metric] 주제 포화도 계산 실패(함수 없음?): Could not find the function public.topic_saturation(payload, window_days) in the schema cache
```

그래서 지금 발굴·신작 탭에서 **에버그린 증가량이 전부 `측정 중`** 이고
**포화도 칩이 하나도 안 뜹니다.** (일평균 조회수는 함수 없이도 나옵니다.)
`recompute_multiples` · `upsert_videos` 는 정상 동작 중입니다(배율 7,348건 갱신 확인).

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

> 실행해도 **발굴 탭은 대부분 계속 `측정 중`** 일 수 있습니다. 백카탈로그로 들어온
> 과거 영상은 스냅샷이 1개뿐이라 증가량을 낼 수 없어서입니다(README 1-j 하단 참고).
> 신작·모아보기 탭은 두 번째 스냅샷이 쌓이는 대로 값이 찹니다.

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

## 참고 — 현재 DB 상태 (2026-08-17 서버 기동 시 실측)

| 함수·테이블 | 상태 | 없으면 |
|---|---|---|
| `public.upsert_videos(payload)` | ✅ 정상 | 수집 자체가 실패 (필수) |
| `public.recompute_multiples()` | ✅ 정상 (배율 7,348건 갱신) | 배율이 없어 발굴 탭이 빈 화면 |
| `public.yt_channel_snapshots` | ✅ 생성됨 (23채널 1일차 기록) | 주간 구독 증가만 안 보임 |
| `public.video_velocity(...)` | ❌ **없음 → 0번 실행 필요** | 에버그린 `최근7일 +N` 이 항상 `측정 중` |
| `public.topic_saturation(...)` | ❌ **없음 → 0번 실행 필요** | 주제 포화도 칩이 안 나옴 |
