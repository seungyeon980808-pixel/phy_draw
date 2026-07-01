/* ===== OBJECT SEARCH (registry filtering + modal interaction only) ===== */

import {
  TEMPLATES,
  activateTemplate,
  buildSymbolIcon,
  sizeIconViewBox,
} from "./templates.js?v=0.36.5";

const CATEGORY_ORDER = ["공통", "광학", "회로", "역학"];

function isTypingTarget(target) {
  return target instanceof HTMLElement && (
    target.matches("input, textarea, select") || target.isContentEditable
  );
}

export function initObjectSearch() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="modal object-search-modal" role="dialog" aria-modal="true" aria-labelledby="object-search-title">
      <h2 class="modal-title" id="object-search-title">오브젝트 검색</h2>
      <input class="modal-input object-search-input" type="text" autocomplete="off"
             placeholder="이름 또는 키워드 검색" aria-label="오브젝트 이름 검색">
      <div class="object-search-results" role="listbox" aria-label="검색 결과"></div>
    </section>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector(".object-search-input");
  const results = overlay.querySelector(".object-search-results");
  let matches = [];
  let highlighted = 0;

  function close() {
    overlay.hidden = true;
    input.value = "";
  }

  function pick(index) {
    const match = matches[index];
    if (!match) return;
    close();
    activateTemplate(match.id);
  }

  function syncHighlight(scroll = false) {
    const rows = results.querySelectorAll(".object-search-row");
    rows.forEach((row, index) => {
      const active = index === highlighted;
      row.classList.toggle("is-highlighted", active);
      row.setAttribute("aria-selected", String(active));
    });
    if (scroll) rows[highlighted]?.scrollIntoView({ block: "nearest" });
  }

  function renderResults() {
    const query = input.value.trim().toLocaleLowerCase();
    matches = Object.entries(TEMPLATES)
      .filter(([, def]) => [def.label, ...(def.keywords || [])]
        .some((value) => String(value).toLocaleLowerCase().includes(query)))
      .map(([id, def]) => ({ id, def }))
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.def.category) - CATEGORY_ORDER.indexOf(b.def.category));
    highlighted = matches.length ? 0 : -1;
    results.replaceChildren();

    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "object-search-empty";
      empty.textContent = "검색 결과가 없습니다.";
      results.appendChild(empty);
      return;
    }

    const categories = [...CATEGORY_ORDER, ...new Set(matches.map(({ def }) => def.category))];
    for (const category of [...new Set(categories)]) {
      const group = matches.filter(({ def }) => def.category === category);
      if (!group.length) continue;

      const heading = document.createElement("div");
      heading.className = "object-search-category";
      heading.textContent = category;
      results.appendChild(heading);

      for (const match of group) {
        const index = matches.indexOf(match);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "object-search-row";
        row.dataset.index = String(index);
        row.setAttribute("role", "option");

        const iconBox = document.createElement("span");
        iconBox.className = "object-search-icon";
        const icon = buildSymbolIcon(match.id, match.def);
        iconBox.appendChild(icon);

        const label = document.createElement("span");
        label.textContent = match.def.label;
        const badge = document.createElement("span");
        badge.className = "object-search-badge";
        badge.textContent = match.def.kind === "atomic" ? "즉시" : "드래그";
        row.append(iconBox, label, badge);
        results.appendChild(row);
        sizeIconViewBox(icon);
      }
    }
    syncHighlight();
  }

  function open() {
    overlay.hidden = false;
    input.value = "";
    renderResults();
    input.focus();
  }

  input.addEventListener("input", renderResults);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!matches.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      highlighted = (highlighted + delta + matches.length) % matches.length;
      syncHighlight(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(highlighted);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  results.addEventListener("mousemove", (event) => {
    const row = event.target.closest(".object-search-row");
    if (!row) return;
    highlighted = Number(row.dataset.index);
    syncHighlight();
  });
  results.addEventListener("dblclick", (event) => {
    const row = event.target.closest(".object-search-row");
    if (row) pick(Number(row.dataset.index));
  });
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "f") return;
    if (isTypingTarget(event.target) && event.target !== input) return;
    event.preventDefault();
    if (overlay.hidden) open();
    else input.focus();
  }, true);
}
