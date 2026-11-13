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
| F4 (컨트롤 창에서는 Tab도) | 사진 ↔ 에뮬레이터 전환 |
| F5 | 일치도 지금 갱신 |
| F6 | 클릭 통과 켜기/끄기 |
| Ctrl+Alt+방향키 (+Shift) | 1px (10px) 미세 이동, Ctrl+Alt+0 초기화 |
| Ctrl+Alt+PageUp/PageDown | 투명도 ±5% |

설정은 `%APPDATA%/wordskills-diff-screen/config.json`에 저장됩니다.
