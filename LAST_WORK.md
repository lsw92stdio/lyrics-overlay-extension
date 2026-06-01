# 마지막 작업 내역 (AI Agent 인수인계용)

> 이 파일은 AI 에이전트 간 작업 인수인계를 위한 문서입니다.
> 작업을 이어받을 때 이 파일을 먼저 읽고 현재 상태를 파악하세요.

---

## 최종 작업일: 2026-06-01

## 현재 버전: v1.2.2 (작업 진행 중, 미출시)

---

## 완료된 작업 1: 다른 에이전트 작업분 버그 수정

이전 에이전트가 구현한 팝업 탭 분리, siteStates 통합, 정렬 기능 등의 코드를 검수하여 3개의 버그를 수정했습니다.

### 수정 1 — `togglePinFromOverlay()` 위치 튀는 버그 (content.js)
- **원인**: `updateSiteState(updates)`는 비동기라서 콜백 안에서 `state.siteState`를 업데이트하기 전에 `restoreSavedPosition()`이 호출됨. 이때 `state.siteState.overlayPinPosition`이 구 값이라 박스가 이전 핀 위치로 튀었음.
- **수정**: `updateSiteState(updates)` 호출 후 `Object.assign(state.siteState, updates)`로 로컬 상태를 즉시 반영한 뒤 `restoreSavedPosition()` 호출.

### 수정 2 — `els` 객체 중복 키 (popup.js)
- `btnExportLibrary`, `libraryList`가 각 2회 선언되어 있던 것을 정리. (JS 특성상 동작은 됐지만 코드 오염)

### 수정 3 — `btnResetDesign` 사이트 `styleOverrides` 미초기화 (popup.js)
- 사이트 모드에서 디자인 초기화 시 글로벌 설정만 리셋하고 `siteStates[hostname].styleOverrides`를 삭제하지 않아서, 초기화 후에도 사이트 디자인이 계속 덮어씌워지는 버그.
- `designTargetSelect === 'site'`일 때 `styleOverrides` 삭제 로직 추가.

---

## 완료된 작업 2: 시트 동기화 Auto Only 카운트 분리 표시

### 변경 내용
- `mergeLyrics()` 반환값에 `autoOnlyAdded`, `autoOnlyUpdated` 분리 추가.
- `buildMergeToast(result)` 함수 신설: `+22 (+1 자동) / ±0` 형태로 포맷.
- 리모컨 자동 연동 완료 메시지(`autoSyncFromSheetIfEmpty`)도 동일하게: `22곡 (+1 자동) 연동 완료`.
- `remote_sync_done` 로케일 메시지 수정 (`$1곡 연동 완료` → `$1 연동 완료`) — 단위를 코드에서 조합.
- `toast_auto_only_label` 로케일 키 추가 (ko: `자동`, en: `auto`, ja: `自動`).
- `remote_songs_unit` 로케일 키 추가 (ko: `곡`, en: ` songs`, ja: `曲`).

### 영향 파일
- `popup/popup.js` — `mergeLyrics`, `buildMergeToast`
- `content/content.js` — `autoSyncFromSheetIfEmpty`
- `_locales/ko,en,ja/messages.json`

---

## 완료된 작업 3: 팝업이 현재 탭의 가사 상태를 정확히 표시

### 문제
`currentTrack`을 전역 스토리지 키(`chrome.storage.local.currentTrack`)에 저장하여 여러 탭 중 마지막으로 가사를 로드한 탭이 덮어씌움. 다른 탭에서 팝업을 열면 엉뚱한 가사 정보가 표시됨.

### 수정
- `content.js`: `chrome.storage.local.set({ currentTrack })` → `updateSiteState({ currentTrack })` (2곳). 사이트(탭)별로 독립 저장.
- `popup.js` 초기화: `siteStates[activeHostname].currentTrack`을 우선 읽고, 없을 때만 전역 `currentTrack` fallback.

### 영향 파일
- `content/content.js` (라이브러리 재생 경로 + LOAD_LYRICS 핸들러)
- `popup/popup.js` (`init()` 함수)

---

## 완료된 작업 4: SoundCloud 자동 감지 성능 최적화

### 문제
`initSoundCloudSync()`의 1초 폴링에서:
1. 매초 `chrome.storage.local.get(['savedLyrics'])` 호출 — 곡이 바뀌지 않아도 매초 전체 라이브러리를 스토리지에서 읽음.
2. 곡이 바뀌지 않았는데도 메타데이터 노멀라이즈·매칭 연산 실행.
3. `getPositionMs()`가 `externalClock.getTimeMs()`로 60fps에서 호출되는데 매번 `querySelectorAll('audio')`, progressbar 쿼리 실행.

### 수정
- **라이브러리 메모리 캐시** (`cachedLibrary`): 초기화 시 1회 읽고, `storage.onChanged`로만 갱신. 매초 storage 읽기 제거.
- **메타 키 캐시** (`lastMetaKey`): 직전 tick과 메타 키가 동일하면 매칭 로직 완전 스킵.
- **DOM 요소 캐시** (`_cachedAudio`, `_cachedPb`, `_cachedHandle`, `_cachedTimePassed`): `getPositionMs()` 내부에서 2초마다만 `querySelectorAll` 재실행. 60fps 루프에서 DOM 쿼리 비용 대폭 감소.

### 영향 파일
- `content/content.js` — `initSoundCloudSync()` 내부

---

## 현재 미완료/주의 사항

- v1.2.2 아직 미출시. manifest 버전 번호 올리기, CHANGELOG 작성, ZIP 패키징 미완료.
- SoundCloud DOM 선택자(`.playbackSoundBadge__titleLink` 등)는 SoundCloud UI 변경 시 튜닝 필요.
