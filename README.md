# wordskills-diff-screen

안드로이드 에뮬레이터 화면과 프로토타입 사진을 겹쳐 눈으로 비교하는 Windows용 Electron 도구.

## 실행
```
npm install
npm start
```
점검(adb·에뮬레이터 불필요): `npm run selftest`

## 사용법
1. **창 선택**: 열린 창 목록에서 에뮬레이터 창을 고릅니다. (AVD의 *Enable Device Frame*은 끄세요.)
2. **화면 영역 보정**: 처음 한 번, 에뮬레이터 화면의 왼쪽 위 → 오른쪽 아래 모서리를 차례로 클릭합니다. 제목줄/도구 막대를 뺀 값이 저장됩니다.
3. **사진 불러오기**: PNG/JPG/BMP. 투명 항상-위 창으로 화면 영역에 덮입니다. 에뮬레이터를 옮기거나 크기를 바꾸면 따라갑니다(자동 맞춤).
4. 투명도 슬라이더, **클릭 통과**(겹친 채 에뮬레이터 조작), 전환 키로 비교합니다.
5. 일치도: `adb exec-out screencap -p`로 받은 화면과 사진을 같은 크기로 맞춰 픽셀 색 차이를 평균 내 `%`로 표시(1.5초마다 자동 / F5). adb는 저장 경로 → PATH → Android SDK `platform-tools` 순으로 찾고, 없으면 [adb 지정].

## 단축키 (전역)
| 키 | 동작 |
|---|---|
| F4 (어느 창에서든) | 사진 ↔ 에뮬레이터 전환 |
| F5 | 일치도 지금 갱신 |
| F6 | 클릭 통과 켜기/끄기 |
| Ctrl+Alt+방향키 (+Shift) | 1px (10px) 미세 이동, Ctrl+Alt+0 초기화 |
| Ctrl+Alt+PageUp/PageDown | 투명도 ±5% |

설정은 `%APPDATA%/wordskills-diff-screen/config.json`에 저장됩니다.

## 배포용 설치 파일
```
npm run build
```
`dist/wordskills-diff-screen-setup-<버전>.exe`(NSIS 설치 프로그램)가 만들어집니다. 코드 서명이 없어 처음 실행 시 SmartScreen 경고가 뜰 수 있습니다.

## 새 기능 (v0.3.0)
- 보기 모드: 사진 / 겹침 / 분할(슬라이더) / 차이(붉게 표시) / 앱 — 어떤 모드에서든 F4로 앱↔직전 모드 전환
- 일치도: 상·중·하 구역별 점수, 상단·하단 제외 %
- 자동 매칭(버튼으로 켬) + 화면↔사진 연결(앱 화면 지문 학습)
- 도구: 측정(px/dp), 가이드선, 눈금자(dp), 색상 스포이드(클립보드 복사)
- 자동 업데이트 (설치본에서만 동작)
- 점검: `npm run selftest`, `npm run e2e`(실제 키 입력), `npm run emutest`(켜진 에뮬레이터 필요)

## 자동 업데이트 배포 절차
1. `package.json`의 version을 올리고 `npm run build`
2. 커밋 후 `git tag v<버전>`, `git push origin main v<버전>`
3. GitHub에서 `v<버전>` 태그로 **공개(draft 아님) 릴리스**를 만들고 `dist/`의 파일 3개를 첨부:
   `wordskills-diff-screen-setup-<버전>.exe`, `…exe.blockmap`, `latest.yml`
4. 설치된 앱은 시작 시/[업데이트 확인]에서 새 버전을 받아 [재시작하여 설치]로 갱신합니다.

※ v0.3.0 이전(v0.2.x) 설치본에는 업데이트 기능이 없어 v0.3.0을 한 번 직접 설치해야 합니다.
