# Lyrics Overlay Extension - 프로젝트 개요 및 가이드 문서

이 문서는 다른 AI 에이전트가 본 프로젝트의 구조와 현재 상태를 빠르게 파악하고, 작업에 바로 투입될 수 있도록 돕기 위해 작성되었습니다.

---

## 1. 프로젝트 개요 (Project Overview)
- **설명**: 웹 페이지 위에 SRT 파일 기반의 싱크 가사를 오버레이 형태로 표시해 주는 크롬 확장프로그램(Chrome Extension)입니다.
- **버전**: Manifest V3 기반 (현재 `v1.4.1` 기준)
- **핵심 목표**: 음악 및 스트리밍 사이트에서 사용자가 원하는 가사를 싱크에 맞춰 편리하게 볼 수 있도록 제공하며, 원문/발음/한국어 번역 등 최대 3줄 포맷을 지원합니다.

---

## 2. 주요 기능 (Main Features)
- **가사 오버레이 (Shadow DOM 활용)**: 호스트 웹 페이지의 스타일에 영향을 받지 않도록 Shadow DOM 내부에 가사창을 렌더링.
- **다국어/다중 라인 가사 지원**: `\N` 구분자를 통해 1줄(단일 텍스트), 2줄(원문+번역), 3줄(원문+발음+번역) 가사를 동적으로 구성하여 표시.
- **가사 정렬 방향**: 가사창 내부 텍스트 및 박스 자체 앵커를 왼쪽/가운데/오른쪽으로 설정 가능.
- **가사창 페이지 고정(Pin)**: 가사창을 뷰포트 기준이 아닌 페이지 좌표에 고정해 스크롤해도 위치를 유지. 가사창 우상단의 핀 버튼으로 토글.
- **자동 가사 선택 및 동기화 (SoundCloud)**: SoundCloud 재생 중인 곡을 자동 감지해 라이브러리에서 매칭되는 가사를 자동 로드하고, 플레이어의 실제 재생 위치(재생바)에 맞춰 싱크.
- **SoundCloud Auto Only**: 구글 시트 D열에 `1`을 입력하면 해당 가사는 라이브러리 목록/검색/곡 수에서 제외되고 자동 감지로만 로드됨.
- **사이트별 전용 테마**: 치지직(Chzzk), 유튜브(YouTube), 트위치(Twitch), 사운드클라우드(SoundCloud) 등 플랫폼에 맞는 플로팅 리모컨 테마(색상) 자동 적용.
- **플로팅 리모컨**: 가사창과 별도로 재생/일시정지, 싱크 미세 조정, 타임라인 이동, 라이브러리 검색 및 선택 제어.
- **이전/다음 가사 표시 (컨텍스트 모드)**: 현재 가사 위/아래에 작은 글씨로 이전·다음 가사를 미리보기. 가사 사이 `GAP_BLANK_MS`(5초) 이상의 간주(공백)는 시퀀스 상의 정식 항목('gap')으로 취급되어 이전/현재/다음이 항상 한 칸씩만 이동하며, 간주 구간은 빈 칸으로 표시됨 (`buildContextSequence`/`getContextSequence`/`findContextAtTime`).
- **가사 라이브러리 및 구글 시트 연동**: 로컬 SRT 파일 등록 또는 구글 시트 URL 연동으로 가사 목록 관리 및 동기화. 시트 열 구성: A=Name, B=SRT Text, C=Keywords, D=Auto Only.
- **다국어 UI**: 한국어/영어/일본어 자동 지원 (`_locales/`).
- **내장 도움말 페이지**: `help/help.html` — 3개 언어 지원, 브라우저 언어 자동 감지.
- **사이트 설정 관리자 (Options Page)**: `options/options.html` — 사이트별 개별 디자인 설정 관리.

---

## 3. 아키텍처 주요 사항

### 팝업 탭 구조
팝업은 3개 탭으로 구성됩니다:
- **플레이어(Player) 탭**: SRT 로드, 재생 제어, 싱크 조정, 타임라인
- **라이브러리(Library) 탭**: 가사 목록, 검색, 구글 시트 연동
- **설정(Settings) 탭**: 동작·연동 관련 설정 (일반 설정)
- **디자인(Design) 탭**: 폰트·색상·애니메이션·정렬·고정 등 시각 설정

### 설정 키 분리
`popup.js`에서 설정 키를 두 그룹으로 분리합니다:
- `GENERAL_KEYS`: 동작·연동 설정 (라이브러리 표시 언어, 구글 시트 URL, 리모컨 버튼, 자동 감지 등)
- `DESIGN_KEYS`: 시각 설정 (폰트 크기·색상·배경·애니메이션·정렬·핀 색상 등)
- 저장/초기화/백업이 탭별로 독립 동작. 디자인은 사이트별 개별 저장(`siteStates`) 지원.

### 사이트별 상태 스토리지 (`siteStates`)
리모컨 위치/최소화, 가사창 위치/고정 상태, 현재 재생 트랙 등 사이트마다 달라야 하는 상태를 단일 객체로 관리합니다:
```json
{
  "siteStates": {
    "soundcloud.com": {
      "isPinned": true,
      "overlayPosition": { "xCenterPercent": 0.5, "bottomPercent": 0.1 },
      "overlayPinPosition": { "docTop": 800, "docCenterX": 960 },
      "remotePosition": { "rightRatio": 0.02, "bottomRatio": 0.05 },
      "remoteMinimized": false,
      "currentTrack": { "name": "...", "count": 42, "duration": 240000, "srtText": "..." },
      "styleOverrides": { "mainFontSize": 32, "bgOpacity": 0.6 }
    }
  }
}
```
- `content.js`의 `updateSiteState(updates)` 함수로 갱신.
- 이전 버전 호환: `siteState`가 없으면 기존 개별 키(`overlayPosition` 등)를 fallback으로 읽음.
- **`currentTrack`**: 팝업 복원용 현재 재생 트랙 정보. 전역 키 대신 사이트별로 저장하여 탭 간 덮어씌움 방지.
- **`styleOverrides`**: 사이트별 디자인 덮어쓰기. 팝업 디자인 탭에서 '현재 사이트' 모드로 저장 시 여기에 기록됨.

### 가사창 레이아웃 구조
```
[host]      position: fixed(기본) / absolute(pin모드); width: 100%; height: 0;
  └─ Shadow DOM
       ├─ [container]  position: fixed / absolute; left: 0; right: 0; (전체 폭)
       │    └─ [box]   position: absolute; width: max-content; max-width: 80vw; bottom: 0;
       │               left/right는 applyContainerAlign()로 정렬에 따라 설정
       ├─ [remote]     플로팅 리모컨
       └─ [progressBar] 진행 바
```
- `applyContainerAlign(container, centerX)`: 정렬 설정(`textAlign`)에 따라 box의 `left`/`right`를 직접 계산해 배치. `translateX(-50%)` transform 미사용.

### 외부 클럭(SoundCloud 싱크)
- `state.externalClock` — SoundCloud 등에서 실제 재생 위치(ms)를 제공하는 객체.
- `null`이면 기존 내부 타이머(`performance.now()`) 사용.
- `initSoundCloudSync()` — soundcloud.com에서만 실행. 1초 폴링으로 곡 변경 감지 → 라이브러리 퍼지 매칭 → 자동 로드.
- `scGetPositionMs` — 수동 재생 시에도 오디오 위치에 싱크하도록 `play()` 함수에서 참조.

**성능 최적화 (initSoundCloudSync 내부):**
- `cachedLibrary`: `savedLyrics`를 메모리에 캐시. `storage.onChanged`로 자동 갱신. 매초 storage 읽기 없음.
- `lastMetaKey`: 직전 tick의 메타 키 캐시. 곡이 바뀌지 않으면 매칭 로직 완전 스킵.
- DOM 요소 캐시(`_cachedAudio`, `_cachedPb` 등): `getPositionMs()`가 60fps로 호출되므로 2초마다만 `querySelectorAll` 재실행.

---

## 4. 디렉토리 구조 및 핵심 파일 (Directory Structure)

```text
lyrics-overlay-extension/
├── manifest.json            # 확장프로그램 메타데이터, 권한, 스크립트 진입점 설정
├── background/
│   └── background.js        # 서비스 워커 (백그라운드 로직)
├── content/
│   ├── content.js           # 오버레이 UI(Shadow DOM), 싱크 관리, 외부 클럭 연동, SoundCloud 자동 감지
│   └── overlay.css          # 콘텐츠 스크립트용 외부 CSS (현재 미사용, 스타일은 content.js 내 getOverlayCSS()에 인라인)
├── popup/
│   ├── popup.html           # 팝업 UI (플레이어/라이브러리/설정/디자인 탭)
│   ├── popup.js             # 팝업 로직 (SRT 로드, 라이브러리 관리, 설정·디자인 저장/초기화/백업)
│   └── popup.css            # 팝업 스타일
├── options/
│   ├── options.html         # 사이트 설정 관리자 UI (사이트별 개별 디자인 설정)
│   ├── options.js           # 사이트 설정 관리자 로직
│   └── options.css          # 사이트 설정 관리자 스타일
├── help/
│   ├── help.html            # 내장 도움말 페이지 (한국어/영어/일본어)
│   └── help.js              # 도움말 언어 전환 로직
├── lib/
│   ├── srt-parser.js        # SRT 파일 파싱 유틸리티
│   ├── sheet-parser.js      # 구글 시트 CSV 파싱, isManualVisible() 포함
│   └── i18n.js              # 다국어 처리 래퍼 (팝업용)
├── _locales/
│   ├── ko/messages.json     # 한국어
│   ├── en/messages.json     # 영어
│   └── ja/messages.json     # 일본어
└── icons/                   # 확장프로그램 아이콘 (16/48/128px)
```

---

## 5. AI 에이전트를 위한 작업 가이드라인

### 기본 원칙
- **팝업 ↔ 콘텐츠 스크립트 통신**: `chrome.storage.local` 변경 감지(`storage.onChanged`) 및 `chrome.tabs.sendMessage`로 동기화.
- **오버레이 디자인 수정**: `content/content.js`의 `getOverlayCSS()` 함수 및 `applySettings()` 함수 참조.
- **설정 추가 시**: `GENERAL_KEYS` 또는 `DESIGN_KEYS` 중 적합한 곳에 키를 추가하고, `defaultSettings`, `loadSettingsUI()`, 저장 핸들러, 로케일 3개 파일(`ko/en/ja`)을 함께 수정.
- **사이트별 상태 수정 시**: `content.js`의 `updateSiteState(updates)` 함수를 사용. `chrome.storage.local`에 `siteStates`키로 직접 쓰지 않도록 주의.

### 자주 참조하는 함수/위치
| 함수/요소 | 위치 | 설명 |
|---|---|---|
| `getOverlayCSS()` | content.js | Shadow DOM 내 전체 CSS 반환 |
| `applySettings(settings)` | content.js | 설정 변경 시 오버레이에 즉시 반영 |
| `applyContainerAlign(c, centerX)` | content.js | 정렬에 따라 box left/right 계산 배치 |
| `updateSiteState(updates)` | content.js | 사이트별 상태 갱신 |
| `initSoundCloudSync()` | content.js | SoundCloud 자동 감지 모듈 (soundcloud.com 전용) |
| `renderLibrary()` | popup.js | 라이브러리 목록 렌더링 (autoOnly 필터 포함) |
| `GENERAL_KEYS` / `DESIGN_KEYS` | popup.js | 설정 키 분류 상수 |
| `isManualVisible(item)` | sheet-parser.js | autoOnly 가사 수동 목록 노출 여부 판별 |
| `buildContextSequence(entries)` / `getContextSequence()` | content.js | 가사+간주(gap)를 하나의 시퀀스로 합쳐 캐싱 (`state.lyrics` 참조 비교로 무효화) |
| `findContextAtTime(seq, t)` / `updateContextDisplay(t)` | content.js | 시퀀스 기준 이전/현재/다음 인덱스 계산 및 컨텍스트 모드 렌더링 |

### 주의사항
- `container.getBoundingClientRect()`는 항상 전체 폭(`left:0, right:0`)을 반환하므로 가사창의 실제 위치가 필요하면 **`box.getBoundingClientRect()`** 를 사용해야 합니다.
- box에 `transform`을 직접 적용하면 `applyContainerAlign()`의 edge 계산과 충돌합니다. scale 피드백 등 일시적 애니메이션에만 사용하고 즉시 제거하세요.
- `settings.textAlign`의 값: `'left'` | `'center'` | `'right'` (기본값: `'center'`)
- 고정(Pin) 모드(`siteState.isPinned`)에서는 호스트의 `position`이 `absolute`로 바뀌고 가사창 위치가 문서 좌표(`docTop`, `docCenterX`)를 기준으로 합니다. 뷰포트 기준 좌표와 혼용하지 않도록 주의.
- `togglePinFromOverlay()`에서 핀 토글 시 `Object.assign(state.siteState, updates)`로 로컬 상태를 즉시 반영한 뒤 `restoreSavedPosition()` 호출해야 합니다. `updateSiteState()`는 비동기이므로 콜백 이전에 호출하면 구 좌표를 읽습니다.
- `currentTrack`은 **전역 스토리지 키가 아닌** `siteStates[hostname].currentTrack`에 저장됩니다. 팝업 복원 시 `siteStates[activeHostname].currentTrack`을 우선 읽고, 없을 때만 전역 `currentTrack`을 fallback으로 사용하세요.
- 리모컨 검색 input(`searchInput`)의 `keydown`/`keyup`/`keypress`는 `stopPropagation()`/`stopImmediatePropagation()`으로 호스트 페이지 버블링을 막습니다. closed Shadow DOM 내부 텍스트 입력 필드를 추가할 경우 동일하게 전파 차단이 필요합니다(그렇지 않으면 유튜브/치지직 등의 전역 단축키와 충돌).
