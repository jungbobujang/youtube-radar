# TODO — Supabase SQL

밤샘 작업(`night-work` 브랜치)에서 **코드만 올리고 DB 는 건드리지 않았습니다.**
아래를 Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요.

실행 전에도 서버는 죽지 않습니다. 해당 기능만 조용히 비어 있습니다.

---

## 1. 구독자 수 일별 이력 (v1.2 · 주간 구독 증가)

**상태: 미실행 — 실행해야 `⚙️ 감시 관리` 화면의 `주간 구독 +N` 이 나옵니다.**

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

## 참고 — 이미 실행되어 있어야 하는 것들

아래는 이번 작업에서 새로 만든 게 아니라 기존 기능이 쓰는 것들입니다.
발굴 탭에 지표가 비어 보이면 README 1-j 절의 SQL 이 실행됐는지 확인하세요.

| 함수 | 없으면 |
|---|---|
| `public.video_velocity(ids, window_days)` | 에버그린의 `최근7일 +N` 이 항상 `측정 중` |
| `public.topic_saturation(payload, window_days)` | 주제 포화도 칩이 안 나옴 |
| `public.recompute_multiples()` | 배율이 계산되지 않아 발굴 탭이 비어 보임 |
| `public.upsert_videos(payload)` | 수집이 실패함 (필수) |
