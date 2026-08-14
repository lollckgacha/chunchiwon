/* =====================================================================
 * main.js — 천치원 시즌2
 * data.js 의 window.CHEONCHIWON_DATA 를 읽어서 화면을 그립니다.
 * (강사진 렌더링 / 지원자 카드 + SOOP 실시간 정보 + Firebase 동기화 /
 *  전술보드 드래그앤드롭)
 * ===================================================================== */

(function () {
  "use strict";

  const DATA = window.CHEONCHIWON_DATA;

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function imgSrc(path) {
    return encodeURI(path);
  }

  function cssEscape(str) {
    return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/["\\]/g, "\\$&");
  }

  /* ------------------------------------------------------------------ */
  /* SOOP(숲) 공개 API — 프로필 사진 / 현재 방송(썸네일) 정보               */
  /* 로그인 필요 없는 공개 엔드포인트라 정적 페이지에서도 그대로 fetch 가능    */
  /* ------------------------------------------------------------------ */
  const stationCache = new Map(); // station id -> Promise<data|null>

  function protocolize(url) {
    if (!url) return "";
    return url.startsWith("//") ? "https:" + url : url;
  }

  function getStationData(station) {
    if (!stationCache.has(station)) {
      const p = fetch(`https://bjapi.afreecatv.com/api/${encodeURIComponent(station)}/station`, {
        cache: "no-store",
      })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
      stationCache.set(station, p);
    }
    return stationCache.get(station);
  }

  function stationUrl(station) {
    return `https://www.sooplive.com/station/${encodeURIComponent(station)}`;
  }

  // 방송 중인 특정 생방송으로 바로 들어가는 시청 페이지 주소 (예: play.sooplive.com/아이디/방송번호)
  function playUrl(station, broadNo) {
    return `https://play.sooplive.com/${encodeURIComponent(station)}/${encodeURIComponent(broadNo)}`;
  }

  /* ------------------------------------------------------------------ */
  /* 포지션 표기 -> 색상 그룹 (GK 노랑 / DF 파랑 / MF 초록 / FW 빨강)          */
  /* 다양한 표기(FB, CB, CDM, CM, CAM, WF, ST ...)를 넓게 인식한다             */
  /* ------------------------------------------------------------------ */
  const POSITION_GROUPS = {
    gk: ["GK", "G"],
    df: ["DF", "FB", "CB", "LB", "RB", "WB", "LWB", "RWB", "SW", "SB"],
    mf: ["MF", "CDM", "CM", "CAM", "DM", "LM", "RM", "AM"],
    fw: ["FW", "WF", "ST", "LW", "RW", "CF", "SS"],
  };
  const POSITION_GROUP_BY_TOKEN = {};
  Object.keys(POSITION_GROUPS).forEach((group) => {
    POSITION_GROUPS[group].forEach((token) => {
      POSITION_GROUP_BY_TOKEN[token] = group;
    });
  });

  function primaryPositionGroup(position) {
    const tokens = String(position || "")
      .split(/[,/]/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (tokens.length === 0) return null;
    return POSITION_GROUP_BY_TOKEN[tokens[0]] || null;
  }

  // "var(--pos-mf)" 같은 참조 문자열. 포지션이 비어있거나 못 알아보는 표기면
  // --pos-none(흰색)을 돌려줘서 "포지션 미정 = 흰 테두리"가 항상 성립하게 한다.
  function positionColorVarValue(position) {
    const group = primaryPositionGroup(position);
    return `var(--pos-${group || "none"})`;
  }

  // HTML 템플릿의 style 속성에 그대로 넣을 수 있는 CSS 변수 선언 문자열
  function positionColorStyle(position) {
    return `--pos-color:${positionColorVarValue(position)}`;
  }

  function positionBadgeHTML(position, extraClass) {
    if (!position) return "";
    const style = positionColorStyle(position);
    return `<span class="position-badge${extraClass ? " " + extraClass : ""}"${style ? ` style="${style}"` : ""}>${esc(position)}</span>`;
  }

  // 정렬 공용 비교 함수 (지통실 정렬 필터 / 전술보드 명단 정렬에서 함께 사용)
  function sortByName(a, b) {
    return a.name.localeCompare(b.name, "ko");
  }

  function sortByPosition(a, b) {
    const order = ["gk", "df", "mf", "fw"];
    const gx = primaryPositionGroup(a.position);
    const gy = primaryPositionGroup(b.position);
    const ix = gx ? order.indexOf(gx) : order.length;
    const iy = gy ? order.indexOf(gy) : order.length;
    if (ix !== iy) return ix - iy;
    return sortByName(a, b);
  }

  const POSITION_GROUP_ORDER = ["gk", "df", "mf", "fw"];

  // 포지션 표기(예: "FB / CDM")를 색상 그룹별로 묶는다. 같은 그룹끼리는 한 묶음으로
  // 합쳐지고(예: "CB / SB" → df 하나), 색이 서로 다른 그룹이 섞여 있으면 그룹별로
  // 따로따로 나뉜다(예: "FB / CDM" → df 하나 + mf 하나) — 전술보드 명단에서 이
  // 각 묶음마다 배지를 하나씩 만들어서, 여러 포지션을 겸하는 선수가 해당하는
  // 모든 색깔 자리에 다 보이게 하기 위함
  function positionGroupBuckets(position) {
    const tokens = String(position || "")
      .split(/[,/]/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (tokens.length === 0) return [{ group: null, label: "" }];

    const order = [];
    const map = new Map();
    tokens.forEach((t) => {
      const group = POSITION_GROUP_BY_TOKEN[t] || null;
      const key = group || "__none__";
      if (!map.has(key)) {
        map.set(key, []);
        order.push(key);
      }
      map.get(key).push(t);
    });
    return order.map((key) => ({ group: key === "__none__" ? null : key, label: map.get(key).join(" / ") }));
  }

  /* ------------------------------------------------------------------ */
  /* 스프레드시트(Firebase) 에서 지원자 명단 불러오기                        */
  /* "지원자 동기화 apps script.txt" 가 같은 경로에 씀 —                     */
  /* 실패하면 data.js 에 들어있는 예비 명단을 그대로 사용                     */
  /* ------------------------------------------------------------------ */
  async function loadApplicantsFromFirebase() {
    if (!DATA.FIREBASE_URL || !DATA.FIREBASE_PATH) return null;
    try {
      const url = DATA.FIREBASE_URL + DATA.FIREBASE_PATH + ".json";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || !Array.isArray(json.applicants) || json.applicants.length === 0) return null;
      return json.applicants
        .filter((a) => a && a.name && a.station)
        .map((a) => ({
          name: String(a.name),
          station: String(a.station),
          postText: a.postText ? String(a.postText) : "",
          position: a.position ? String(a.position) : "",
          photo: a.photo ? String(a.photo) : "",
        }));
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 강사진 탭                                                            */
  /* ------------------------------------------------------------------ */
  function renderInstructors() {
    const grid = document.getElementById("instructor-grid");
    if (!grid) return;
    grid.innerHTML = DATA.INSTRUCTORS.map((m) => {
      // 방송국이 있으면 카드 전체를 방송국으로 가는 링크(<a>)로, 없으면 그냥 <div>로 렌더
      const tag = m.station ? "a" : "div";
      const linkAttrs = m.station
        ? ` href="${esc(stationUrl(m.station))}" target="_blank" rel="noopener noreferrer"`
        : "";
      return `
      <${tag} class="instructor-card"${linkAttrs}>
        <div class="instructor-photo-wrap">
          <img class="instructor-photo" src="${imgSrc(m.photo)}" alt="${esc(m.name)}" loading="lazy" />
        </div>
        <div class="instructor-role">${esc(m.role)}</div>
        <div class="instructor-name">${esc(m.name)}</div>
      </${tag}>`;
    }).join("");
  }

  // 지원자 카드/피드 공용 — 프로필 사진(있으면) 또는 이름 첫 글자 아바타
  function avatarInnerHTML(a) {
    return a.photo
      ? `<img src="${esc(a.photo)}" alt="${esc(a.name)} 프로필" loading="lazy" />`
      : `<span class="applicant-avatar-fallback">${esc(a.name.charAt(0))}</span>`;
  }

  /* ------------------------------------------------------------------ */
  /* 지원자 탭 — 지원글을 쭉 모아보는 피드                                    */
  /* 글 자체는 네트워크 요청 없이 즉시 뜨고, 방송국 프로필 사진만 지통실처럼      */
  /* SOOP에서 비동기로 불러와 채운다                                        */
  /* ------------------------------------------------------------------ */
  function postFeedItemHTML(a) {
    const style = positionColorStyle(a.position);
    const text = a.postText && a.postText.trim() ? esc(a.postText) : "(지원글이 아직 없어요)";
    return `
    <article class="post-feed-item" style="${style}">
      <header class="post-feed-header">
        <div class="applicant-avatar post-feed-avatar" data-role="avatar" data-station="${esc(a.station)}">${avatarInnerHTML(a)}</div>
        <span class="post-feed-name">${esc(a.name)}</span>
        ${positionBadgeHTML(a.position)}
        <a class="post-feed-station" href="${esc(stationUrl(a.station))}" target="_blank" rel="noopener noreferrer">@${esc(a.station)} ↗</a>
      </header>
      <div class="post-feed-text">${text}</div>
    </article>`;
  }

  function renderPostFeed() {
    const feed = document.getElementById("post-feed");
    const countEl = document.getElementById("post-feed-count");
    if (!feed) return;

    const sorted = DATA.APPLICANTS.slice().sort((a, b) => a.name.localeCompare(b.name, "ko"));
    feed.innerHTML = sorted.map(postFeedItemHTML).join("");
    if (countEl) countEl.textContent = `총 ${DATA.APPLICANTS.length}명 지원`;

    sorted.forEach((a) => {
      if (a.photo) return; // 시트에 사진이 직접 지정돼 있으면 이미 채워져 있으니 건너뜀
      getStationData(a.station).then((data) => {
        if (!data || !data.profile_image) return;
        const avatarEl = feed.querySelector(`.post-feed-avatar[data-station="${cssEscape(a.station)}"]`);
        if (avatarEl) avatarEl.innerHTML = `<img src="${esc(protocolize(data.profile_image))}" alt="${esc(a.name)} 프로필" loading="lazy" />`;
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 지통실 탭 — SOOP 실시간 방송 현황판 (사진/썸네일/방송중 여부 + 정렬)       */
  /* ------------------------------------------------------------------ */
  function controlCardHTML(a) {
    const cardStyle = positionColorStyle(a.position);
    return `
    <div class="applicant-card" style="${cardStyle}" data-station="${esc(a.station)}">
      <div class="applicant-head">
        <div class="applicant-avatar" data-role="avatar">${avatarInnerHTML(a)}</div>
        <div class="applicant-head-text">
          <div class="applicant-name">${esc(a.name)}</div>
          <div class="applicant-id">@${esc(a.station)}</div>
        </div>
        ${positionBadgeHTML(a.position)}
        <span class="applicant-live-badge" data-role="live-badge" hidden>LIVE</span>
      </div>
      <div class="applicant-thumb-wrap" data-role="thumb">
        <div class="applicant-thumb-loading">불러오는 중...</div>
      </div>
      <div class="applicant-actions">
        <a class="btn-station" href="${esc(stationUrl(a.station))}" target="_blank" rel="noopener noreferrer">📡 방송국</a>
      </div>
    </div>`;
  }

  function isLiveEntry(entry) {
    return !!(entry.data && entry.data.broad && entry.data.broad.broad_no);
  }

  // 방송 중인 사람이 항상 먼저 오고, 그 안에서 포지션별/가나다순으로 다시 정렬
  function withLiveFirst(compare) {
    return (x, y) => {
      const liveX = isLiveEntry(x) ? 1 : 0;
      const liveY = isLiveEntry(y) ? 1 : 0;
      if (liveX !== liveY) return liveY - liveX;
      return compare(x.a, y.a);
    };
  }

  const CONTROL_SORTERS = {
    position: withLiveFirst(sortByPosition),
    name: withLiveFirst(sortByName),
  };

  let controlRoomData = null; // [{a, data}] — SOOP 조회 결과 캐시 (정렬 바꿀 때 재요청 안 하도록)
  let controlSortMode = "position";

  // SOOP "EA Sports FC 26" 카테고리 번호(broad_cate_no) — 실제로 그 카테고리에서
  // 방송 중인 스트리머(김웰로/이루희 등)의 bjapi 응답을 직접 확인해서 얻은 값
  const FC26_CATE_NO = 40354;
  let controlOnlyFC26 = true; // "잔디만" 필터 — 기본값으로 켜져 있음

  function renderControlGrid() {
    const grid = document.getElementById("control-grid");
    if (!grid || !controlRoomData) return;

    const filtered = controlOnlyFC26
      ? controlRoomData.filter(({ data }) => data && data.broad && data.broad.broad_cate_no === FC26_CATE_NO)
      : controlRoomData;

    const sorted = filtered.slice().sort(CONTROL_SORTERS[controlSortMode] || CONTROL_SORTERS.live);

    grid.innerHTML = sorted.length
      ? sorted.map(({ a }) => controlCardHTML(a)).join("")
      : `<p class="applicant-loading">지금 EA Sports FC 26을 방송 중인 지원자가 없어요.</p>`;

    sorted.forEach(({ a, data }) => {
      const card = grid.querySelector(`.applicant-card[data-station="${cssEscape(a.station)}"]`);
      if (card) applyStationDataToControlCard(card, a, data);
    });
  }

  function applyStationDataToControlCard(card, applicant, data) {
    const avatarEl = card.querySelector('[data-role="avatar"]');
    const thumbEl = card.querySelector('[data-role="thumb"]');
    const liveBadgeEl = card.querySelector('[data-role="live-badge"]');

    if (!data) {
      thumbEl.innerHTML = `<div class="applicant-thumb-offline"><span>정보를 불러오지 못했어요</span></div>`;
      return;
    }

    // 사진링크가 시트에 직접 지정돼 있으면 그걸 우선 쓰고, 없을 때만 SOOP 프로필로 채운다
    if (!applicant.photo && data.profile_image) {
      avatarEl.innerHTML = `<img src="${esc(protocolize(data.profile_image))}" alt="${esc(applicant.name)} 프로필" loading="lazy" />`;
    }

    if (data.broad && data.broad.broad_no) {
      card.classList.add("is-live");
      liveBadgeEl.hidden = false;
      const thumbUrl = `https://liveimg.sooplive.co.kr/h/${data.broad.broad_no}`;
      const thumbImg = `<img class="applicant-thumb" src="${thumbUrl}" alt="${esc(applicant.name)} 방송 썸네일" loading="lazy" />`;
      // 썸네일을 누르면 해당 생방송 시청 페이지로 바로 이동 (예: play.sooplive.com/아이디/방송번호)
      thumbEl.innerHTML = `<a class="applicant-thumb-link" href="${esc(playUrl(applicant.station, data.broad.broad_no))}" target="_blank" rel="noopener noreferrer" title="실시간 방송 보러가기">${thumbImg}</a>`;
      if (data.broad.broad_title) {
        thumbEl.title = data.broad.broad_title;
      }
    } else {
      // 방송 중이 아닌 카드는 CSS(.applicant-card:not(.is-live))로 어둡게 표시됨
      thumbEl.innerHTML = `<div class="applicant-thumb-offline"><span>현재 방송 중이 아니에요</span></div>`;
    }
  }

  async function renderControlRoom() {
    const grid = document.getElementById("control-grid");
    const countEl = document.getElementById("control-count");
    if (!grid) return;

    grid.innerHTML = `<p class="applicant-loading">지원자 목록을 불러오는 중...</p>`;

    controlRoomData = await Promise.all(
      DATA.APPLICANTS.map((a) => getStationData(a.station).then((data) => ({ a, data })))
    );

    if (countEl) countEl.textContent = `총 ${DATA.APPLICANTS.length}명 지원`;
    renderControlGrid();
  }

  document.querySelectorAll(".control-toolbar .sort-btn[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.sort === controlSortMode) return;
      controlSortMode = btn.dataset.sort;
      document.querySelectorAll(".control-toolbar .sort-btn[data-sort]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderControlGrid();
    });
  });

  const controlOnlyFC26Btn = document.getElementById("control-only-fc26");
  if (controlOnlyFC26Btn) {
    controlOnlyFC26Btn.addEventListener("click", () => {
      controlOnlyFC26 = !controlOnlyFC26;
      controlOnlyFC26Btn.classList.toggle("active", controlOnlyFC26);
      renderControlGrid();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 상단 탭 전환 — URL 해시로 기록해서 브라우저 뒤로/앞으로가기로도 이동 가능      */
  /* ------------------------------------------------------------------ */
  // 그리기 도구 상태는 아래에서 선언되지만, 주소창에 #tab-board 해시가 있는 채로 처음
  // 들어오면 이 시점보다도 먼저(초기 탭 부팅 시) fitPitchToViewport→resizeDrawingCanvas가
  // 호출될 수 있어서 미리 선언해둔다 (안 그러면 TDZ 참조 오류로 페이지가 멈춤)
  let strokes = []; // [{ color, points: [{x,y}] }] — x,y는 그라운드 기준 0~100% 좌표
  let activeDrawColor = null;
  let currentStroke = null;
  let drawingCanvasEl = null;

  // 그라운드 방향(가로/세로) — 같은 이유로 여기서 미리 선언해둔다
  const ORIENTATION_STORAGE_KEY = "cheonchiwon-s2-formation-orientation-v1";
  let pitchOrientation = localStorage.getItem(ORIENTATION_STORAGE_KEY) === "portrait" ? "portrait" : "landscape";

  const TAB_IDS = Array.from(document.querySelectorAll(".nav-tab[data-tab]")).map((b) => b.dataset.tab);
  const DEFAULT_TAB_ID = TAB_IDS[0];

  function activateTab(tabId, opts) {
    opts = opts || {};
    if (!TAB_IDS.includes(tabId)) return;
    const wasBoard = document.body.classList.contains("board-active");
    document.querySelectorAll(".nav-tab[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === tabId));
    if (opts.push !== false) {
      const hash = "#" + tabId;
      if (location.hash !== hash) history.pushState({ tabId }, "", hash);
    }

    // 전술보드 탭에서는 상단 바 고정을 풀어서, 아래로 스크롤하면 진짜로 화면 밖으로
    // 넘어가고 큰 그라운드만 남는 프레젠테이션 모드가 되게 한다
    document.body.classList.toggle("board-active", tabId === "tab-board");
    if (tabId !== "tab-board" && wasBoard) {
      window.scrollTo(0, 0); // 그라운드 화면 보다가 다른 탭으로 넘어가면 상단 UI가 바로 보이게 되돌린다
    }

    // 방금 보이게 된 탭이 전술보드/일정이면, 그 탭 크기가 화면에 맞게 다시 계산되어야 한다
    // (안 보이는 동안엔 실측이 불가능해서 렌더 시점엔 계산을 건너뛰었음)
    if (tabId === "tab-board") {
      fitPitchToViewport();
      const stage = document.querySelector(".board-stage");
      if (stage) stage.scrollIntoView({ behavior: "auto", block: "start" });
    }
    if (tabId === "tab-schedule") fitCalendarToViewport();
  }

  document.querySelectorAll(".nav-tab[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  window.addEventListener("popstate", (e) => {
    const tabId = (e.state && e.state.tabId) || (location.hash || "").replace("#", "") || DEFAULT_TAB_ID;
    activateTab(tabId, { push: false });
  });

  // 처음 들어왔을 때 주소에 탭 해시가 있으면 그 탭으로 시작하고,
  // 없으면 기본 탭으로 히스토리를 한 번 정리해둬서 이후 뒤로가기가 자연스럽게 동작하게 한다
  const initialTabId = (location.hash || "").replace("#", "");
  if (TAB_IDS.includes(initialTabId)) {
    activateTab(initialTabId, { push: false });
  } else {
    history.replaceState({ tabId: DEFAULT_TAB_ID }, "", "#" + DEFAULT_TAB_ID);
  }

  /* ------------------------------------------------------------------ */
  /* 맨 위로 이동 버튼 — 지원자/지통실처럼 목록이 긴 탭에서 스크롤을 좀 내리면 */
  /* 오른쪽 아래에 나타나서, 누르면 상단 메뉴가 있는 맨 위로 데려다준다        */
  /* ------------------------------------------------------------------ */
  const scrollTopBtn = document.getElementById("scroll-top-btn");
  if (scrollTopBtn) {
    const SCROLL_SHOW_THRESHOLD = 400;
    window.addEventListener("scroll", () => {
      scrollTopBtn.classList.toggle("visible", window.scrollY > SCROLL_SHOW_THRESHOLD);
    });
    scrollTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 일정 탭 — 달력 (기본: 2026년 8월, 좌우 화살표로 다른 달도 볼 수 있음)      */
  /* ------------------------------------------------------------------ */
  function formatTimeKo(hhmm) {
    if (!hhmm) return "";
    const [h, m] = hhmm.split(":").map(Number);
    const period = h < 12 ? "오전" : "오후";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${period} ${h12}시 ${m}분` : `${period} ${h12}시`;
  }

  let calendarViewDate = new Date(2026, 7, 1); // 2026년 8월 (월은 0부터 시작하므로 7)

  function renderCalendar() {
    const grid = document.getElementById("calendar-grid");
    const label = document.getElementById("calendar-month-label");
    if (!grid) return;

    const year = calendarViewDate.getFullYear();
    const month = calendarViewDate.getMonth();
    if (label) label.textContent = `${year}년 ${month + 1}월`;

    const eventsByDate = {};
    (DATA.SCHEDULE || []).forEach((ev) => {
      (eventsByDate[ev.date] = eventsByDate[ev.date] || []).push(ev);
    });

    const startWeekday = new Date(year, month, 1).getDay(); // 0=일
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < startWeekday; i++) {
      cells.push(`<div class="calendar-cell calendar-cell--empty"></div>`);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const events = eventsByDate[iso] || [];
      const weekday = new Date(year, month, d).getDay();
      const weekdayClass = weekday === 0 ? " calendar-cell--sun" : weekday === 6 ? " calendar-cell--sat" : "";
      const eventsHTML = events
        .map(
          (ev) => `
        <div class="calendar-event">
          ${ev.time ? `<span class="calendar-event-time">${esc(formatTimeKo(ev.time))}</span>` : ""}
          <span class="calendar-event-title">${esc(ev.title)}</span>
        </div>`
        )
        .join("");
      cells.push(`
        <div class="calendar-cell${weekdayClass}${events.length ? " has-event" : ""}">
          <span class="calendar-day-num">${d}</span>
          ${eventsHTML}
        </div>`);
    }

    grid.innerHTML = cells.join("");
    fitCalendarToViewport();
  }

  // 화면에 남는 세로 공간을 실측해서 달력 칸(정사각형) 크기를 그만큼 꽉 채운다.
  // (공간이 부족하면 줄이고, 넉넉하면 — 예: 푸터를 뺀 만큼 — 키운다) 요일 줄도
  // 달력과 정확히 같은 너비로 맞춰서 가운데 정렬이 서로 어긋나지 않게 한다.
  function fitCalendarToViewport() {
    const tab = document.getElementById("tab-schedule");
    const grid = document.getElementById("calendar-grid");
    const weekdays = document.querySelector(".calendar-weekdays");
    const mainEl = document.querySelector("main");
    if (!tab || !grid || !tab.classList.contains("active")) return;

    grid.style.width = "";
    if (weekdays) weekdays.style.width = "";
    // 스타일을 되돌린 직후 바로 측정하면(getBoundingClientRect 호출 시 브라우저가
    // 강제로 동기 레이아웃을 계산해줌) 프레임을 기다릴 필요 없이 바로 정확한 값을 잴 수 있다.
    // (requestAnimationFrame은 이 페이지가 실제로 화면에 그려지고 있을 때만 불려서,
    //  창이 최소화/백그라운드 상태면 영영 안 불릴 수 있어 여기선 쓰지 않는다)
    const totalCells = grid.children.length;
    if (totalCells === 0) return;
    const rows = Math.max(1, Math.ceil(totalCells / 7));
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;

    const gridTop = grid.getBoundingClientRect().top; // 탑바+제목+툴바+요일줄까지 포함된 윗공간
    const mainPaddingBottom = mainEl ? parseFloat(getComputedStyle(mainEl).paddingBottom) : 0;

    const availableHeight = window.innerHeight - gridTop - mainPaddingBottom - 4;
    const cellSize = Math.max(28, (availableHeight - gap * (rows - 1)) / rows);
    const targetWidth = cellSize * 7 + gap * 6;

    const wrapWidth = grid.parentElement.getBoundingClientRect().width;
    const finalWidth = Math.max(200, Math.min(targetWidth, wrapWidth));

    grid.style.width = finalWidth + "px";
    if (weekdays) weekdays.style.width = finalWidth + "px";
  }

  window.addEventListener("resize", fitCalendarToViewport);

  const calendarPrevBtn = document.getElementById("calendar-prev");
  const calendarNextBtn = document.getElementById("calendar-next");
  if (calendarPrevBtn) {
    calendarPrevBtn.addEventListener("click", () => {
      calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
      renderCalendar();
    });
  }
  if (calendarNextBtn) {
    calendarNextBtn.addEventListener("click", () => {
      calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
      renderCalendar();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 전술보드 탭 — 드래그 앤 드롭 포메이션 보드 (지원자 명단 기반)             */
  /* ------------------------------------------------------------------ */

  // tacticalboard.html처럼 그라운드가 화면을 거의 다 채우도록 크게 잡는다.
  // 좌우 플로팅 패널(명단/도구)과는 겹치지 않고 살짝 여백이 남도록, 패널이 실제로
  // 차지한 폭 + 여백만큼은 그라운드 너비 계산에서 제외한다 (패널을 접으면 그만큼
  // 그라운드가 다시 넓어짐). 뷰포트 높이의 90%를 기준으로 축구장 비율(109:86)은 유지.
  function fitPitchToViewport() {
    const tab = document.getElementById("tab-board");
    const wrap = document.querySelector(".pitch-wrap");
    const pitch = document.getElementById("pitch");
    const rosterPanel = document.getElementById("roster-panel");
    const toolsPanel = document.getElementById("tools-panel");
    if (!tab || !wrap || !pitch || !tab.classList.contains("active")) return;

    pitch.style.width = "";
    pitch.style.height = "";
    // 스타일을 되돌린 직후 바로 측정하면(getBoundingClientRect 호출 시 브라우저가
    // 강제로 동기 레이아웃을 계산해줌) 프레임을 기다릴 필요 없이 바로 정확한 값을 잴 수 있다.
    const isPortrait = pitchOrientation === "portrait";
    const aspect = isPortrait ? 86 / 109 : 109 / 86; // 가로:세로 비율 (세로 모드는 뒤집힘)
    const targetHeight = Math.max(360, window.innerHeight * 0.9);
    const targetWidth = targetHeight * aspect;

    const GAP = 24; // 패널과 그라운드 사이에 남길 여백
    const wrapRect = wrap.getBoundingClientRect();
    const rosterReserve = rosterPanel ? rosterPanel.getBoundingClientRect().right - wrapRect.left + GAP : 0;
    const toolsReserve = toolsPanel ? wrapRect.right - toolsPanel.getBoundingClientRect().left + GAP : 0;
    const maxWidth = Math.max(320, wrapRect.width - Math.max(0, rosterReserve) - Math.max(0, toolsReserve));

    const finalWidth = Math.min(targetWidth, maxWidth);
    const finalHeight = finalWidth / aspect;

    pitch.style.width = finalWidth + "px";
    pitch.style.height = finalHeight + "px";

    applyPitchOrientationToSvg(pitch, finalWidth, finalHeight);
    resizeDrawingCanvas(); // 그라운드 크기가 바뀌었으니 그리기 캔버스도 같이 다시 맞춘다
  }

  // 세로 모드에서는 그라운드 그림(SVG)만 90도 돌려서 채운다. 선수 칩/그리기는
  // 그대로 박스 기준 0~100% 좌표를 쓰기 때문에 별도 처리가 필요 없다 —
  // 그림만 돌아간 상자에 맞게 다시 그려지는 셈
  function applyPitchOrientationToSvg(pitchEl, boxWidth, boxHeight) {
    const svg = pitchEl.querySelector(":scope > svg");
    if (!svg) return;
    if (pitchOrientation === "portrait") {
      svg.style.position = "absolute";
      svg.style.top = "50%";
      svg.style.left = "50%";
      svg.style.width = boxHeight + "px";
      svg.style.height = boxWidth + "px";
      svg.style.transform = "translate(-50%, -50%) rotate(-90deg)"; // 반시계 방향 — 가로일 때의 왼쪽이 세로에서 아래로
    } else {
      svg.style.position = "";
      svg.style.top = "";
      svg.style.left = "";
      svg.style.width = "";
      svg.style.height = "";
      svg.style.transform = "";
    }
  }

  // 그라운드 그림이 90도 돌아가면, 그 위에 놓인 선수/더미 위치나 그려둔 선도
  // 같은 실제 지점을 계속 가리키도록 좌표를 같이 돌려준다.
  // toOrientation === "portrait"면 반시계방향(왼쪽→아래), 다시 "landscape"로 돌아가면 그 반대(시계방향)로 되돌린다.
  function rotateCoordForOrientation(x, y, toOrientation) {
    if (toOrientation === "portrait") return { x: y, y: 100 - x };
    return { x: 100 - y, y: x };
  }

  function pitchHintTextFor(orientation) {
    return orientation === "portrait"
      ? "그라운드 안은 선발, 좌우 사이드라인 밖 어두운 공간은 벤치예요. 다시 드래그해서 옮길 수 있고, ×를 누르거나 명단 쪽으로 끌면 제거돼요."
      : "그라운드 안은 선발, 위아래 사이드라인 밖 어두운 공간은 벤치예요. 다시 드래그해서 옮길 수 있고, ×를 누르거나 명단 쪽으로 끌면 제거돼요.";
  }

  window.addEventListener("resize", fitPitchToViewport);

  /* ------------------------------------------------------------------ */
  /* 전술보드 그리기 도구 — 빨간펜/파란펜으로 화살표·동선 등을 자유롭게 그림     */
  /* ------------------------------------------------------------------ */
  const DRAWING_STORAGE_KEY = "cheonchiwon-s2-formation-drawings-v1";
  const DRAW_COLORS = { red: "#ff5a5a", blue: "#4d9fff" };

  function loadStrokes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DRAWING_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveStrokes() {
    localStorage.setItem(DRAWING_STORAGE_KEY, JSON.stringify(strokes));
  }

  function paintStroke(ctx, canvas, s) {
    if (!s.points || s.points.length < 2) return;
    ctx.strokeStyle = DRAW_COLORS[s.color] || DRAW_COLORS.red;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = (p.x / 100) * canvas.width;
      const y = (p.y / 100) * canvas.height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function redrawStrokes() {
    if (!drawingCanvasEl) return;
    const ctx = drawingCanvasEl.getContext("2d");
    ctx.clearRect(0, 0, drawingCanvasEl.width, drawingCanvasEl.height);
    strokes.forEach((s) => paintStroke(ctx, drawingCanvasEl, s));
  }

  function pointFromPointerEvent(canvas, ev) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((ev.clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((ev.clientY - rect.top) / rect.height) * 100)),
    };
  }

  function setActiveDrawColor(color) {
    activeDrawColor = color;
    if (drawingCanvasEl) drawingCanvasEl.classList.toggle("active", !!color);
    document.querySelectorAll(".draw-btn[data-color]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.color === color);
    });
  }

  function undoStroke() {
    if (strokes.length === 0) return;
    strokes.pop();
    redrawStrokes();
    saveStrokes();
  }

  function clearStrokes() {
    if (strokes.length === 0) return;
    if (!confirm("그려진 내용을 모두 지울까요?")) return;
    strokes = [];
    redrawStrokes();
    saveStrokes();
  }

  function wireDrawingCanvasEvents(canvas) {
    canvas.addEventListener("pointerdown", (e) => {
      if (!activeDrawColor || e.button !== 0) return;
      e.preventDefault();
      currentStroke = { color: activeDrawColor, points: [pointFromPointerEvent(canvas, e)] };
      strokes.push(currentStroke);
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!currentStroke) return;
      currentStroke.points.push(pointFromPointerEvent(canvas, e));
      redrawStrokes();
    });
    function endStroke() {
      if (!currentStroke) return;
      currentStroke = null;
      saveStrokes();
    }
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);
  }

  // 그라운드 크기가 바뀔 때마다 캔버스 픽셀 크기도 맞추고 저장된 선을 다시 그린다
  function resizeDrawingCanvas() {
    const pitchEl = document.getElementById("pitch");
    if (!pitchEl) return;

    let canvas = document.getElementById("drawing-canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "drawing-canvas";
      canvas.className = "drawing-canvas";
      pitchEl.appendChild(canvas);
      wireDrawingCanvasEvents(canvas);
    }
    drawingCanvasEl = canvas;

    const rect = pitchEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // 탭이 안 보이는 동안엔 건너뜀
    canvas.width = rect.width;
    canvas.height = rect.height;
    redrawStrokes();
  }

  function initDrawingTools() {
    strokes = loadStrokes();
    resizeDrawingCanvas();

    document.querySelectorAll(".draw-btn[data-color]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActiveDrawColor(activeDrawColor === btn.dataset.color ? null : btn.dataset.color);
      });
    });

    const undoBtn = document.getElementById("draw-undo");
    if (undoBtn) undoBtn.addEventListener("click", undoStroke);

    const clearBtn = document.getElementById("draw-clear");
    if (clearBtn) clearBtn.addEventListener("click", clearStrokes);

    // ESC로 펜 끄기, Ctrl+Z(⌘Z)로 되돌리기 — 전술보드 탭을 보고 있을 때만 동작
    document.addEventListener("keydown", (e) => {
      const boardTab = document.getElementById("tab-board");
      if (!boardTab || !boardTab.classList.contains("active")) return;
      if (e.key === "Escape") setActiveDrawColor(null);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoStroke();
      }
    });
  }

  const AVATAR_CANVAS_SIZE = 96; // 캔버스 내부 해상도(px). CSS로 실제 크기에 맞게 축소돼 표시됨

  function loadImageEl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image(); // DOM에 붙이지 않고 메모리에서만 디코드 → GIF도 애니메이션 없이 첫 프레임만 얻을 수 있음
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  // cover 방식으로 이미지를 캔버스에 그린다 (중앙 크롭)
  function drawImageCover(canvas, source) {
    const ctx = canvas.getContext("2d");
    const cw = canvas.width, ch = canvas.height;
    const iw = source.naturalWidth || source.width;
    const ih = source.naturalHeight || source.height;
    if (!iw || !ih) return;
    const scale = Math.max(cw / iw, ch / ih);
    const sw = cw / scale, sh = ch / scale;
    const sx = (iw - sw) / 2, sy = (ih - sh) / 2;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, cw, ch);
  }

  function ensureAvatarCanvas(container) {
    let canvas = container.querySelector(":scope > canvas.avatar-canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "avatar-canvas";
      canvas.width = AVATAR_CANVAS_SIZE;
      canvas.height = AVATAR_CANVAS_SIZE;
      container.prepend(canvas);
    }
    return canvas;
  }

  // 전술보드 칩(명단/그라운드)에 정지 프레임으로 사진을 그린다.
  // <img> 대신 캔버스에 한 번만 그려서 넣기 때문에, 원본이 움직이는 GIF여도 애니메이션되지 않는다.
  function paintFrozenAvatar(container, img, isFieldChip) {
    const canvas = ensureAvatarCanvas(container);
    drawImageCover(canvas, img);
    container.classList.add(isFieldChip ? "player-chip--photo" : "roster-chip--photo");
  }

  function initFormationBoard() {
    const applicantByName = new Map(DATA.APPLICANTS.map((a) => [a.name, a]));

    const STORAGE_KEY = "cheonchiwon-s2-formation-v1";
    const CUSTOM_STORAGE_KEY = "cheonchiwon-s2-formation-custom-v1";
    const GRASS_TOP_PCT = 10.5;
    const GRASS_BOTTOM_PCT = 89.5;

    const rosterListEl = document.getElementById("roster-list");
    const rosterSearchEl = document.getElementById("roster-search");
    const rosterPanelEl = document.getElementById("roster-panel");
    const rosterAddInputEl = document.getElementById("roster-add-input");
    const rosterAddBtnEl = document.getElementById("roster-add-btn");
    const pitchEl = document.getElementById("pitch");
    const pitchTokensEl = document.getElementById("pitch-tokens");
    const placedCountEl = document.getElementById("placed-count");
    const btnClear = document.getElementById("btn-clear");

    if (!rosterListEl || !pitchEl) return; // 전술보드 탭이 없는 페이지에서는 건너뜀

    let positions = {}; // name -> {x, y} (percent)
    let rosterSortMode = "position";

    /* -------------------------------------------------------------- */
    /* 직접 추가한 선수 — 지원자 명단에 없는 이름을 사진(천치원 로고)만       */
    /* 붙여서 명단에 끼워 넣는다. 실제 지원자 목록(DATA.APPLICANTS)은         */
    /* 건드리지 않고, 로컬에만 저장되는 별도 명단으로 관리한다                 */
    /* -------------------------------------------------------------- */
    function loadCustomPlayers() {
      try {
        const parsed = JSON.parse(localStorage.getItem(CUSTOM_STORAGE_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string" && n.trim()) : [];
      } catch (e) {
        return [];
      }
    }

    function saveCustomPlayers() {
      localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(customPlayers));
    }

    let customPlayers = loadCustomPlayers();
    customPlayers.forEach((name) => {
      if (!applicantByName.has(name)) {
        applicantByName.set(name, { name, station: null, position: "", photo: "logo.png", custom: true });
      }
    });

    function allPlayerNames() {
      return Array.from(applicantByName.keys());
    }

    function addCustomPlayer(rawName) {
      const name = rawName.trim();
      if (!name) return "empty";
      if (applicantByName.has(name)) return "duplicate";
      applicantByName.set(name, { name, station: null, position: "", photo: "logo.png", custom: true });
      customPlayers.push(name);
      saveCustomPlayers();
      return "ok";
    }

    function removeCustomPlayer(name) {
      customPlayers = customPlayers.filter((n) => n !== name);
      applicantByName.delete(name);
      delete positions[name];
      saveCustomPlayers();
      saveState();
    }

    /* -------------------------------------------------------------- */
    /* 더미선수 — 이름/사진 없이 사이트 메인 컬러 코인만 그라운드에 놓는 표식     */
    /* (지원자 명단과 무관하게 도구 패널에서 바로 추가/이동/삭제)                */
    /* -------------------------------------------------------------- */
    const DUMMY_STORAGE_KEY = "cheonchiwon-s2-formation-dummies-v1";

    function loadDummyTokens() {
      try {
        const parsed = JSON.parse(localStorage.getItem(DUMMY_STORAGE_KEY) || "[]");
        if (!Array.isArray(parsed)) return [];
        const valid = parsed.filter((d) => d && typeof d.id === "string" && typeof d.x === "number" && typeof d.y === "number");
        // 이 기능이 생기기 전에 저장된 더미(번호 없음)는 순서대로 번호를 새로 매겨준다
        let nextNum = 1;
        valid.forEach((d) => {
          if (typeof d.number !== "number") d.number = nextNum;
          nextNum = Math.max(nextNum, d.number) + 1;
        });
        return valid;
      } catch (e) {
        return [];
      }
    }

    function saveDummyTokens() {
      localStorage.setItem(DUMMY_STORAGE_KEY, JSON.stringify(dummyTokens));
    }

    let dummyTokens = loadDummyTokens();

    // 지금까지 쓰인 가장 큰 번호 다음 번호를 매긴다 (지워도 번호가 재사용되지 않음)
    function nextDummyNumber() {
      return dummyTokens.reduce((max, d) => Math.max(max, d.number || 0), 0) + 1;
    }

    function addDummyToken() {
      dummyTokens.push({
        id: "dummy-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        x: 50,
        y: 50,
        number: nextDummyNumber(),
      });
      saveDummyTokens();
      renderDummyTokens();
    }

    function removeDummyToken(id) {
      dummyTokens = dummyTokens.filter((d) => d.id !== id);
      saveDummyTokens();
      renderDummyTokens();
    }

    function renderDummyTokens() {
      pitchTokensEl.querySelectorAll(".player-chip--dummy").forEach((el) => el.remove());
      dummyTokens.forEach((d) => createDummyChip(d));
    }

    function createDummyChip(d) {
      const chip = document.createElement("div");
      chip.className = "player-chip player-chip--field player-chip--dummy";
      chip.dataset.dummyId = d.id;
      chip.title = "더미선수 " + d.number;
      chip.style.left = d.x + "%";
      chip.style.top = d.y + "%";

      const numberEl = document.createElement("span");
      numberEl.className = "dummy-number";
      numberEl.style.fontSize = fontSizeForDummyNumber(d.number);
      numberEl.textContent = String(d.number);
      chip.appendChild(numberEl);

      const removeBtn = document.createElement("span");
      removeBtn.className = "token-remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeDummyToken(d.id);
      });
      chip.appendChild(removeBtn);

      chip.addEventListener("pointerdown", (e) => startDummyDrag(e, chip, d));
      pitchTokensEl.appendChild(chip);
    }

    // 지원자 코인과 같은 방식 — 드래그하는 동안은 마우스를 따라다니는 고스트만 보이고
    // (원본은 숨김), 놓는 순간 트랜지션 없이 그 자리에 바로 스냅된다
    function startDummyDrag(e, chip, d) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();

      const ghost = document.createElement("div");
      ghost.className = "player-chip player-chip--ghost player-chip--dummy";
      const ghostNumberEl = document.createElement("span");
      ghostNumberEl.className = "dummy-number";
      ghostNumberEl.style.fontSize = fontSizeForDummyNumber(d.number);
      ghostNumberEl.textContent = String(d.number);
      ghost.appendChild(ghostNumberEl);
      document.body.appendChild(ghost);
      moveGhost(ghost, e.clientX, e.clientY);

      chip.classList.add("dragging");
      try { chip.setPointerCapture(e.pointerId); } catch (err) {}

      function onMove(ev) {
        moveGhost(ghost, ev.clientX, ev.clientY);
      }

      function onUp(ev) {
        chip.removeEventListener("pointermove", onMove);
        chip.removeEventListener("pointerup", onUp);
        chip.removeEventListener("pointercancel", onUp);
        ghost.remove();

        const rect = pitchTokensEl.getBoundingClientRect();
        const inPitch = ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
        if (inPitch) {
          const xPct = clampPct(((ev.clientX - rect.left) / rect.width) * 100);
          const yPct = clampPct(((ev.clientY - rect.top) / rect.height) * 100);
          d.x = xPct;
          d.y = yPct;
          // 트랜지션 강제로 끈 채로 최종 위치를 먼저 반영한 뒤 원본을 다시 보여준다
          chip.style.transition = "none";
          chip.style.left = xPct + "%";
          chip.style.top = yPct + "%";
          void chip.offsetWidth;
          chip.style.transition = "";
          saveDummyTokens();
        }
        chip.classList.remove("dragging");
      }

      chip.addEventListener("pointermove", onMove);
      chip.addEventListener("pointerup", onUp);
      chip.addEventListener("pointercancel", onUp);
    }

    /* -------------------------------------------------------------- */
    /* 그라운드 방향(가로/세로) 전환                                          */
    /* -------------------------------------------------------------- */
    function setOrientation(newOrientation) {
      if (newOrientation === pitchOrientation || (newOrientation !== "portrait" && newOrientation !== "landscape")) return;

      // 이미 놓인 선수/더미/그림이 같은 실제 지점을 계속 가리키도록 좌표를 같이 돌린다
      Object.keys(positions).forEach((name) => {
        const p = positions[name];
        const r = rotateCoordForOrientation(p.x, p.y, newOrientation);
        positions[name] = { x: clampPct(r.x), y: clampPct(r.y) };
      });
      dummyTokens.forEach((d) => {
        const r = rotateCoordForOrientation(d.x, d.y, newOrientation);
        d.x = clampPct(r.x);
        d.y = clampPct(r.y);
      });
      strokes.forEach((s) => {
        s.points = s.points.map((pt) => rotateCoordForOrientation(pt.x, pt.y, newOrientation));
      });

      pitchOrientation = newOrientation;
      localStorage.setItem(ORIENTATION_STORAGE_KEY, pitchOrientation);
      saveState();
      saveDummyTokens();
      saveStrokes();

      document.querySelectorAll(".orientation-btn[data-orientation]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.orientation === pitchOrientation);
      });
      const hintEl = document.getElementById("pitch-hint");
      if (hintEl) hintEl.textContent = pitchHintTextFor(pitchOrientation);

      fitPitchToViewport(); // 그라운드 크기/그림(SVG) 방향과 그리기 캔버스를 다시 맞춘다
      renderAll();
      renderDummyTokens();
    }

    function loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        const valid = {};
        const known = new Set(allPlayerNames());
        Object.keys(parsed).forEach((name) => {
          const p = parsed[name];
          if (known.has(name) && p && typeof p.x === "number" && typeof p.y === "number") {
            valid[name] = p;
          }
        });
        return valid;
      } catch (e) {
        return {};
      }
    }

    function saveState() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
    }

    // 세로 모드에서는 그라운드 그림이 90도 돌아가 있어서, 벤치(사이드라인 밖) 공간이
    // 위/아래가 아니라 좌/우 가장자리로 옮겨간다 — 그래서 어느 축을 볼지 방향에 따라 바꿔준다
    function isOnGrass(xPct, yPct) {
      const v = pitchOrientation === "portrait" ? xPct : yPct;
      return v >= GRASS_TOP_PCT && v <= GRASS_BOTTOM_PCT;
    }

    function clampPct(v) {
      return Math.min(97, Math.max(3, v));
    }

    function fontSizeForName(name) {
      const len = name.length;
      if (len <= 3) return "11px";
      if (len <= 5) return "9.5px";
      if (len <= 8) return "8.5px";
      return "7.5px";
    }

    function fontSizeForDummyNumber(num) {
      const len = String(num).length;
      if (len <= 1) return "22px";
      if (len === 2) return "17px";
      return "13px";
    }

    function updateCounts() {
      const names = Object.keys(positions);
      const onGrass = names.filter((n) => isOnGrass(positions[n].x, positions[n].y)).length;
      const onBench = names.length - onGrass;
      placedCountEl.textContent = `그라운드 ${onGrass} · 벤치 ${onBench} / 전체 ${allPlayerNames().length}`;
    }

    /* -------------------------------------------------------------- */
    /* 지원자 프로필 사진 적용 (SOOP API 로 비동기 도착, 정지 프레임으로 고정)     */
    /* -------------------------------------------------------------- */
    function hookPhoto(name) {
      const applicant = applicantByName.get(name);
      if (!applicant) return;

      const photoUrlPromise = applicant.photo
        ? Promise.resolve(applicant.photo)
        : getStationData(applicant.station).then((data) =>
            data && data.profile_image ? protocolize(data.profile_image) : null
          );

      photoUrlPromise
        .then((url) => (url ? loadImageEl(url) : null))
        .then((img) => {
          if (!img) return;

          // 여러 포지션 색상을 겸하는 선수는 명단에 칩이 여러 개 있을 수 있어서 전부 칠한다
          rosterListEl.querySelectorAll(`.roster-chip[data-name="${cssEscape(name)}"]`).forEach((rosterChip) => {
            const rosterAvatar = rosterChip.querySelector(".roster-avatar");
            if (rosterAvatar) paintFrozenAvatar(rosterAvatar, img, false);
          });

          const fieldChip = pitchTokensEl.querySelector(`.player-chip[data-name="${cssEscape(name)}"]`);
          if (fieldChip) paintFrozenAvatar(fieldChip, img, true);
        })
        .catch(() => {});
    }

    /* -------------------------------------------------------------- */
    /* 렌더링                                                              */
    /* -------------------------------------------------------------- */
    // 여러 포지션(색이 다른 그룹)을 겸하는 선수는 명단에 그 색깔 수만큼 칩이 따로 생긴다.
    // 예: "FB / CDM" → 파란 FB 칩 + 초록 CDM 칩. 실제로는 같은 선수(positions[name] 기준)라
    // 하나를 그라운드로 옮기면 두 칩이 한꺼번에 어두워진다(.placed)
    function buildRosterChip(applicant, bucket) {
      const name = applicant.name;
      const chip = document.createElement("div");
      chip.className = "roster-chip" + (positions[name] ? " placed" : "") + (applicant.custom ? " roster-chip--custom" : "");
      chip.dataset.name = name;
      chip.title = name;
      const posColorVar = `var(--pos-${bucket.group || "none"})`;
      chip.style.setProperty("--pos-color", posColorVar);

      const avatar = document.createElement("span");
      avatar.className = "roster-avatar";
      avatar.textContent = name.charAt(0);

      // 이름 위, 포지션 배지 아래로 두 줄로 쌓이게 감싼다
      const textWrap = document.createElement("span");
      textWrap.className = "roster-chip-text";

      const label = document.createElement("span");
      label.className = "roster-name";
      label.textContent = name;
      textWrap.appendChild(label);

      if (bucket.label) {
        const posBadge = document.createElement("span");
        posBadge.className = "roster-position-badge";
        posBadge.style.setProperty("--pos-color", posColorVar);
        posBadge.textContent = bucket.label;
        textWrap.appendChild(posBadge);
      }

      chip.appendChild(avatar);
      chip.appendChild(textWrap);

      if (applicant.custom) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "roster-chip-remove";
        removeBtn.setAttribute("aria-label", `${name} 삭제`);
        removeBtn.title = "명단에서 삭제";
        removeBtn.textContent = "×";
        removeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          removeCustomPlayer(name);
          renderAll();
        });
        chip.appendChild(removeBtn);
      }

      return chip;
    }

    function renderRoster() {
      rosterListEl.innerHTML = "";
      const all = Array.from(applicantByName.values());
      const customOnes = all.filter((a) => a.custom);
      const normalOnes = all.filter((a) => !a.custom);

      // 선수 하나당 포지션 색 그룹 수만큼 {applicant, bucket} 항목을 만든다
      function toEntries(list) {
        const entries = [];
        list.forEach((applicant) => {
          positionGroupBuckets(applicant.position).forEach((bucket) => entries.push({ applicant, bucket }));
        });
        return entries;
      }

      const customEntries = toEntries(customOnes).sort((a, b) => sortByName(a.applicant, b.applicant));
      const normalEntries = toEntries(normalOnes);

      if (rosterSortMode === "position") {
        normalEntries.sort((a, b) => {
          const ix = a.bucket.group ? POSITION_GROUP_ORDER.indexOf(a.bucket.group) : POSITION_GROUP_ORDER.length;
          const iy = b.bucket.group ? POSITION_GROUP_ORDER.indexOf(b.bucket.group) : POSITION_GROUP_ORDER.length;
          if (ix !== iy) return ix - iy;
          return sortByName(a.applicant, b.applicant);
        });
      } else {
        normalEntries.sort((a, b) => sortByName(a.applicant, b.applicant));
      }

      // 직접 추가한 선수는 정렬 기준과 무관하게 항상 명단 맨 위에 모아둔다
      const entries = customEntries.concat(normalEntries);

      const seenNames = new Set();
      entries.forEach(({ applicant, bucket }) => {
        const chip = buildRosterChip(applicant, bucket);
        rosterListEl.appendChild(chip);
        chip.addEventListener("pointerdown", (e) => startChipDrag(e, chip, applicant.name, "roster"));
        if (!seenNames.has(applicant.name)) {
          seenNames.add(applicant.name);
          hookPhoto(applicant.name); // 사진은 이름당 한 번만 불러오면 됨 (칩이 여러 개면 안에서 전부 칠해줌)
        }
      });
      filterRoster();
    }

    function filterRoster() {
      const q = rosterSearchEl.value.trim().toLowerCase();
      rosterListEl.querySelectorAll(".roster-chip").forEach((chip) => {
        const match = chip.dataset.name.toLowerCase().includes(q);
        chip.style.display = match ? "" : "none";
      });
    }

    function renderPitch() {
      // 더미선수 코인은 이름이 없는 별도 토큰이라 여기서는 건드리지 않는다 (renderDummyTokens가 따로 관리)
      const existing = new Map();
      pitchTokensEl.querySelectorAll(".player-chip:not(.player-chip--dummy)").forEach((el) => existing.set(el.dataset.name, el));

      existing.forEach((el, name) => {
        if (!Object.prototype.hasOwnProperty.call(positions, name)) el.remove();
      });

      Object.keys(positions).forEach((name) => {
        const p = positions[name];
        const chip = existing.get(name);
        if (chip) {
          moveChipTo(chip, p.x, p.y);
        } else {
          const newChip = createChip(name, p.x, p.y);
          pitchTokensEl.appendChild(newChip);
          hookPhoto(name);
        }
      });
    }

    function moveChipTo(chip, xPct, yPct) {
      // 방금 내가 직접 드래그해서 놓은 칩(dragging 클래스가 아직 남아있음)은
      // CSS 트랜지션에 기대지 않고 인라인으로 강제로 즉시 이동시킨다.
      // (다른 선수와 자리를 바꿔서 "밀려나는" 칩은 여기 해당 안 되니 계속 부드럽게 슬라이드됨)
      const isBeingDropped = chip.classList.contains("dragging");
      if (isBeingDropped) chip.style.transition = "none";

      chip.style.left = xPct + "%";
      chip.style.top = yPct + "%";
      chip.classList.toggle("player-chip--bench-zone", !isOnGrass(xPct, yPct));

      if (isBeingDropped) {
        void chip.offsetWidth; // 강제 리플로우: 트랜지션 없이 위치가 바로 반영되게 확정
        chip.style.transition = "";
      }
    }

    function renderAll() {
      renderRoster();
      renderPitch();
      updateCounts();
    }

    /* -------------------------------------------------------------- */
    /* 선수 칩 (그라운드 / 벤치 공용)                                        */
    /* -------------------------------------------------------------- */
    function createChip(name, xPct, yPct) {
      const applicant = applicantByName.get(name);
      const chip = document.createElement("div");
      chip.className = "player-chip player-chip--field" + (isOnGrass(xPct, yPct) ? "" : " player-chip--bench-zone");
      chip.dataset.name = name;
      chip.title = name;
      chip.style.left = xPct + "%";
      chip.style.top = yPct + "%";
      const posColorVar = positionColorVarValue(applicant && applicant.position);
      if (posColorVar) chip.style.setProperty("--pos-color", posColorVar);

      const nameEl = document.createElement("span");
      nameEl.className = "token-name";
      nameEl.style.fontSize = fontSizeForName(name);
      nameEl.textContent = name;
      chip.appendChild(nameEl);

      const removeBtn = document.createElement("span");
      removeBtn.className = "token-remove";
      removeBtn.textContent = "×";
      removeBtn.title = "명단으로 되돌리기";
      chip.appendChild(removeBtn);

      removeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        sendToRoster(name);
        saveState();
        renderAll();
      });

      chip.addEventListener("pointerdown", (e) => startChipDrag(e, chip, name, "placed"));

      return chip;
    }

    /* -------------------------------------------------------------- */
    /* 상태 전환 헬퍼                                                       */
    /* -------------------------------------------------------------- */
    function sendToPitch(name, xPct, yPct) {
      positions[name] = { x: clampPct(xPct), y: clampPct(yPct) };
    }

    function sendToRoster(name) {
      delete positions[name];
    }

    function swapWithChip(name, targetName, dropXPct, dropYPct) {
      if (!targetName || targetName === name) {
        sendToPitch(name, dropXPct, dropYPct);
        return;
      }
      const targetPos = positions[targetName] ? { ...positions[targetName] } : { x: clampPct(dropXPct), y: clampPct(dropYPct) };
      const sourcePos = positions[name] ? { ...positions[name] } : null;

      positions[targetName] = sourcePos ? sourcePos : undefined;
      if (!sourcePos) delete positions[targetName];
      positions[name] = targetPos;
    }

    /* -------------------------------------------------------------- */
    /* 드래그 앤 드롭 (명단 <-> 그라운드/벤치 공용 판)                             */
    /* -------------------------------------------------------------- */
    let highlightedZoneEl = null;

    function resolveDropZone(clientX, clientY) {
      const pitchRect = pitchTokensEl.getBoundingClientRect();
      if (clientX >= pitchRect.left && clientX <= pitchRect.right && clientY >= pitchRect.top && clientY <= pitchRect.bottom) {
        return {
          type: "pitch",
          xPct: ((clientX - pitchRect.left) / pitchRect.width) * 100,
          yPct: ((clientY - pitchRect.top) / pitchRect.height) * 100,
        };
      }
      const rosterRect = rosterListEl.getBoundingClientRect();
      if (clientX >= rosterRect.left && clientX <= rosterRect.right && clientY >= rosterRect.top && clientY <= rosterRect.bottom) {
        return { type: "roster" };
      }
      return null;
    }

    function zoneHighlightEl(zoneType) {
      if (zoneType === "pitch") return pitchEl;
      if (zoneType === "roster") return rosterPanelEl;
      return null;
    }

    function updateDropHighlight(clientX, clientY) {
      const zone = resolveDropZone(clientX, clientY);
      const target = zone ? zoneHighlightEl(zone.type) : null;
      if (highlightedZoneEl && highlightedZoneEl !== target) highlightedZoneEl.classList.remove("drop-target");
      if (target) target.classList.add("drop-target");
      highlightedZoneEl = target;
    }

    function clearDropHighlight() {
      if (highlightedZoneEl) highlightedZoneEl.classList.remove("drop-target");
      highlightedZoneEl = null;
    }

    // 고스트(드래그 중 마우스를 따라다니는 칩)를 커서 위치로 옮긴다
    function moveGhost(ghost, clientX, clientY) {
      ghost.style.left = clientX + "px";
      ghost.style.top = clientY + "px";
    }

    function findChipAt(clientX, clientY, excludeName) {
      // 더미선수 코인은 이름이 없어 자리 교환 대상이 될 수 없으니 검색에서 제외
      const chips = pitchTokensEl.querySelectorAll(".player-chip:not(.player-chip--dummy)");
      for (const chip of chips) {
        if (chip.dataset.name === excludeName) continue;
        const r = chip.getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
          return chip;
        }
      }
      return null;
    }

    let highlightedSwapEl = null;

    function updateSwapHighlight(clientX, clientY, name) {
      const target = findChipAt(clientX, clientY, name);
      if (highlightedSwapEl && highlightedSwapEl !== target) highlightedSwapEl.classList.remove("swap-target");
      if (target) target.classList.add("swap-target");
      highlightedSwapEl = target;
    }

    function clearSwapHighlight() {
      if (highlightedSwapEl) highlightedSwapEl.classList.remove("swap-target");
      highlightedSwapEl = null;
    }

    // 원본 칩에 이미 그려둔 정지 프레임 캔버스를, 마우스를 따라다니는 고스트 칩에도 그대로 복사한다
    // (원본 <img>가 아니라 캔버스를 소스로 그리기 때문에 여기서도 GIF가 움직이지 않는다)
    function cloneAvatarCanvas(sourceCanvas) {
      if (!sourceCanvas) return null;
      const canvas = document.createElement("canvas");
      canvas.className = "avatar-canvas";
      canvas.width = sourceCanvas.width;
      canvas.height = sourceCanvas.height;
      canvas.getContext("2d").drawImage(sourceCanvas, 0, 0);
      return canvas;
    }

    function startChipDrag(e, sourceEl, name, sourceType) {
      if (e.button !== undefined && e.button !== 0) return;
      if (sourceType === "roster" && sourceEl.classList.contains("placed")) return;
      e.preventDefault();

      const applicant = applicantByName.get(name);
      const posColorVar = positionColorVarValue(applicant && applicant.position);

      const ghost = document.createElement("div");
      ghost.className = "player-chip player-chip--ghost";
      if (posColorVar) ghost.style.setProperty("--pos-color", posColorVar);

      // 마우스를 따라다니는 고스트가 실제 칩과 같은 크기/사진으로 보이도록 맞춘다
      let sourceCanvas = null;
      if (sourceType === "roster") {
        const avatarEl = sourceEl.querySelector(".roster-avatar");
        sourceCanvas = avatarEl && avatarEl.querySelector("canvas.avatar-canvas");
      } else {
        const rect = sourceEl.getBoundingClientRect();
        ghost.style.width = rect.width + "px";
        ghost.style.height = rect.height + "px";
        sourceCanvas = sourceEl.querySelector(":scope > canvas.avatar-canvas");
      }
      const ghostCanvas = cloneAvatarCanvas(sourceCanvas);
      if (ghostCanvas) {
        ghost.appendChild(ghostCanvas);
        ghost.classList.add("player-chip--photo");
      }

      const nameEl = document.createElement("span");
      nameEl.className = "token-name";
      nameEl.style.fontSize = fontSizeForName(name);
      nameEl.textContent = name;
      ghost.appendChild(nameEl);
      document.body.appendChild(ghost);
      moveGhost(ghost, e.clientX, e.clientY);

      // 이미 배치된 칩을 옮길 때는 원본을 숨기고, 고스트만 보이게 해서
      // "칩 자체가 마우스를 따라다니는" 것처럼 느껴지게 한다
      if (sourceType !== "roster") sourceEl.classList.add("dragging");
      try { sourceEl.setPointerCapture(e.pointerId); } catch (err) {}

      function onMove(ev) {
        moveGhost(ghost, ev.clientX, ev.clientY);
        updateDropHighlight(ev.clientX, ev.clientY);
        updateSwapHighlight(ev.clientX, ev.clientY, name);
      }

      function onUp(ev) {
        sourceEl.removeEventListener("pointermove", onMove);
        sourceEl.removeEventListener("pointerup", onUp);
        sourceEl.removeEventListener("pointercancel", onUp);
        ghost.remove();
        clearDropHighlight();

        const zone = resolveDropZone(ev.clientX, ev.clientY);
        const swapTargetEl = findChipAt(ev.clientX, ev.clientY, name);
        clearSwapHighlight();

        if (zone) {
          if (zone.type === "pitch") {
            if (swapTargetEl) {
              swapWithChip(name, swapTargetEl.dataset.name, zone.xPct, zone.yPct);
            } else {
              sendToPitch(name, zone.xPct, zone.yPct);
            }
          } else if (zone.type === "roster") {
            sendToRoster(name);
          }
          saveState();
          // 옮긴 칩이 아직 숨겨져(dragging) 있는 동안(transition:none) 위치를 먼저 최종값으로
          // 반영해서, 원본을 다시 보여줄 때 옛 위치 → 새 위치로 슬라이드하는 게 아니라
          // 바로 새 위치에 나타나게 한다 (잠깐 원위치로 되돌아가 보이는 깜빡임 방지)
          renderAll();
        }

        // 위치 반영이 끝난 뒤에 원본을 다시 보이게 한다
        if (sourceType !== "roster") sourceEl.classList.remove("dragging");
      }

      sourceEl.addEventListener("pointermove", onMove);
      sourceEl.addEventListener("pointerup", onUp);
      sourceEl.addEventListener("pointercancel", onUp);
    }

    /* -------------------------------------------------------------- */
    /* 그라운드 스크린샷 — 캔버스에 새로 그려서 PNG로 내려받는다.               */
    /* (SOOP에서 불러온 프로필 사진은 다른 도메인 이미지라 캔버스에 그대로     */
    /* 박아 내보내면 브라우저 보안 정책에 막히기 때문에, 사진 대신 포지션      */
    /* 색이 칠해진 원 + 이름으로 그린다. 로고는 우리 사이트 파일이라 그대로    */
    /* 그릴 수 있어서 직접추가 선수는 천치원 로고가 그대로 나온다)             */
    /* -------------------------------------------------------------- */
    function resolvePosColorHex(position) {
      const group = primaryPositionGroup(position);
      const varName = `--pos-${group || "none"}`;
      const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      return val || "#53f7ba";
    }

    async function exportPitchAsImage() {
      const rect = pitchEl.getBoundingClientRect();
      const boxWidth = rect.width;
      const boxHeight = rect.height;
      if (!boxWidth || !boxHeight) return;

      const scale = 2; // 다운로드했을 때 더 선명하게 보이도록 2배 해상도로 그림
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(boxWidth * scale);
      canvas.height = Math.round(boxHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);

      ctx.fillStyle = "#0d3d20";
      ctx.fillRect(0, 0, boxWidth, boxHeight);

      // 그라운드 라인(SVG)을 이미지로 바꿔서 그린다 — 세로 모드면 화면에 보이는 그대로 회전해서.
      // 세로 모드에서는 실제 svg 요소에 회전용 인라인 style이 이미 붙어있으니, 복제본에서
      // 그 style을 지우고 "돌아가지 않은 원본" 그림을 얻은 뒤 캔버스에서 직접 회전시킨다
      // (안 지우면 인라인 회전 + 캔버스 회전이 겹쳐서 그림이 이중으로 돌아가 버림)
      try {
        const svgEl = pitchEl.querySelector(":scope > svg");
        const svgClone = svgEl.cloneNode(true);
        svgClone.removeAttribute("style");
        const svgMarkup = new XMLSerializer().serializeToString(svgClone);
        const svgDataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgMarkup);
        const svgImg = await loadImageEl(svgDataUrl);
        ctx.save();
        if (pitchOrientation === "portrait") {
          ctx.translate(boxWidth / 2, boxHeight / 2);
          ctx.rotate(-Math.PI / 2);
          ctx.drawImage(svgImg, -boxHeight / 2, -boxWidth / 2, boxHeight, boxWidth);
        } else {
          ctx.drawImage(svgImg, 0, 0, boxWidth, boxHeight);
        }
        ctx.restore();
      } catch (err) {
        // 그림 로드가 실패해도 아래 선/마커는 계속 그려서 최소한의 결과물은 남긴다
      }

      // 그려둔 펜 선
      strokes.forEach((s) => paintStroke(ctx, { width: boxWidth, height: boxHeight }, s));

      const chipDiameter = Math.min(62, Math.max(36, boxWidth * 0.12)); // .player-chip--field와 동일한 크기 규칙
      const r = chipDiameter / 2;

      // 직접추가 선수는 천치원 로고가 같은 도메인 파일이라 캔버스에 그대로 그려도 안전하다
      let logoImg = null;
      if (Array.from(applicantByName.values()).some((a) => a.custom && positions[a.name])) {
        try { logoImg = await loadImageEl("logo.png"); } catch (err) { logoImg = null; }
      }

      // 더미선수 코인 (사이트 메인 컬러 단색 + 중앙에 번호)
      dummyTokens.forEach((d) => {
        const cx = (d.x / 100) * boxWidth;
        const cy = (d.y / 100) * boxHeight;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = "#53f7ba";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#35c996";
        ctx.stroke();

        ctx.fillStyle = "#04140c";
        ctx.font = `900 ${Math.max(11, r * 0.62)}px "Segoe UI", "Malgun Gothic", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(d.number != null ? d.number : ""), cx, cy);
      });

      // 배치된 지원자 — 포지션 색 테두리 원 + 이름 (직접추가 선수는 로고 사진)
      Object.keys(positions).forEach((name) => {
        const p = positions[name];
        const applicant = applicantByName.get(name);
        const cx = (p.x / 100) * boxWidth;
        const cy = (p.y / 100) * boxHeight;

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = "#151d24";
        ctx.fill();

        if (applicant && applicant.custom && logoImg) {
          ctx.save();
          ctx.clip();
          const side = Math.min(logoImg.width, logoImg.height);
          const sx = (logoImg.width - side) / 2;
          const sy = (logoImg.height - side) / 2;
          ctx.drawImage(logoImg, sx, sy, side, side, cx - r, cy - r, r * 2, r * 2);
          ctx.restore();
        } else {
          ctx.fillStyle = "#ffffff";
          ctx.font = `700 ${Math.max(10, r * 0.5)}px "Segoe UI", "Malgun Gothic", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(name.charAt(0), cx, cy);
        }

        ctx.lineWidth = 3;
        ctx.strokeStyle = resolvePosColorHex(applicant && applicant.position);
        ctx.stroke();

        ctx.fillStyle = "#e9fff2";
        ctx.font = `700 ${Math.max(9, r * 0.34)}px "Segoe UI", "Malgun Gothic", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(name, cx, cy + r + 6);
      });

      canvas.toBlob((blob) => {
        if (!blob) {
          alert("이미지 생성에 실패했어요. 다시 시도해주세요.");
          return;
        }
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const a = document.createElement("a");
        a.href = url;
        a.download = `천치원-전술보드-${stamp}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }, "image/png");
    }

    /* -------------------------------------------------------------- */
    /* 초기화                                                              */
    /* -------------------------------------------------------------- */
    rosterSearchEl.addEventListener("input", filterRoster);

    // 직접추가 — 지원자 명단에 없는 이름을 직접 입력해서 추가 (사진은 천치원 로고)
    if (rosterAddBtnEl && rosterAddInputEl) {
      const submitAddPlayer = () => {
        const result = addCustomPlayer(rosterAddInputEl.value);
        if (result === "duplicate") {
          alert("이미 명단에 있는 이름이에요.");
          return;
        }
        if (result === "ok") {
          rosterAddInputEl.value = "";
          renderAll();
        }
      };
      rosterAddBtnEl.addEventListener("click", submitAddPlayer);
      rosterAddInputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitAddPlayer();
        }
      });
    }

    document.querySelectorAll(".roster-sort-btn[data-sort]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.sort === rosterSortMode) return;
        rosterSortMode = btn.dataset.sort;
        document.querySelectorAll(".roster-sort-btn[data-sort]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderRoster(); // 그라운드에 놓인 배치는 그대로 두고 명단 목록 순서만 바뀜
      });
    });

    btnClear.addEventListener("click", () => {
      if (Object.keys(positions).length === 0 && dummyTokens.length === 0) return;
      if (!confirm("그라운드와 벤치에 배치된 지원자와 더미선수를 모두 되돌릴까요?")) return;
      positions = {};
      dummyTokens = [];
      renderAll();
      renderDummyTokens();
      saveState();
      saveDummyTokens();
    });

    const btnAddDummy = document.getElementById("btn-add-dummy");
    if (btnAddDummy) {
      btnAddDummy.addEventListener("click", addDummyToken);
    }

    const btnScreenshot = document.getElementById("btn-screenshot");
    if (btnScreenshot) {
      btnScreenshot.addEventListener("click", () => {
        btnScreenshot.disabled = true;
        exportPitchAsImage().finally(() => { btnScreenshot.disabled = false; });
      });
    }

    // 가로/세로 그라운드 전환 버튼
    document.querySelectorAll(".orientation-btn[data-orientation]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.orientation === pitchOrientation);
      btn.addEventListener("click", () => setOrientation(btn.dataset.orientation));
    });
    const pitchHintEl = document.getElementById("pitch-hint");
    if (pitchHintEl) pitchHintEl.textContent = pitchHintTextFor(pitchOrientation);

    // 명단 접기/펼치기 — 접으면 그라운드가 그만큼 넓어진다
    // 명단(좌측)/도구(우측) 플로팅 패널 접기·펼치기 — 회전 표시는 CSS가 처리
    const rosterToggleBtn = document.getElementById("roster-toggle");
    if (rosterToggleBtn) {
      rosterToggleBtn.addEventListener("click", () => {
        rosterPanelEl.classList.toggle("collapsed");
      });
    }

    const toolsPanelEl = document.getElementById("tools-panel");
    const toolsToggleBtn = document.getElementById("tools-toggle");
    if (toolsToggleBtn && toolsPanelEl) {
      toolsToggleBtn.addEventListener("click", () => {
        toolsPanelEl.classList.toggle("collapsed");
      });
    }

    positions = loadState();
    renderAll();
    renderDummyTokens();
    fitPitchToViewport();
  }

  /* ------------------------------------------------------------------ */
  /* 초기 렌더                                                              */
  /* ------------------------------------------------------------------ */
  async function boot() {
    document.title = DATA.CLUB_NAME;
    document.querySelectorAll(".club-name-slot").forEach((el) => (el.textContent = DATA.CLUB_NAME));

    renderInstructors();

    // data.js 의 예비 명단(포지션 등 포함)을 station 기준으로 보관해뒀다가,
    // Firebase 쪽 데이터에 특정 필드가 비어있으면 여기서 채워 넣는다.
    // (예: 포지션 컬럼을 추가하기 전 버전의 Apps Script로 이미 보낸 적이 있어서
    //  Firebase에는 position이 없는 경우에도 사이트에서 색이 안 사라지도록)
    const fallbackByStation = new Map(DATA.APPLICANTS.map((a) => [a.station, a]));

    const liveApplicants = await loadApplicantsFromFirebase();
    if (liveApplicants) {
      DATA.APPLICANTS = liveApplicants.map((a) => {
        const fb = fallbackByStation.get(a.station);
        return {
          ...a,
          position: a.position || (fb && fb.position) || "",
          photo: a.photo || (fb && fb.photo) || "",
        };
      });
    }

    renderPostFeed();
    renderCalendar();
    await renderControlRoom();
    initFormationBoard();
    initDrawingTools();
  }

  boot();
})();
