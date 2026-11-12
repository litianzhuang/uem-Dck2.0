"use strict";

(() => {
  const views = Array.from(document.querySelectorAll(".page-view[data-page]"));
  const links = Array.from(document.querySelectorAll("[data-nav]"));
  const pages = new Set(links.map(link => link.dataset.nav));

  function show(page) {
    if (!pages.has(page)) page = "overview";
    for (const view of views) view.hidden = view.dataset.page !== page;
    for (const link of links) {
      if (link.dataset.nav === page) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function fromHash() {
    show(window.location.hash.slice(1) || "overview");
  }

  for (const link of links) {
    link.addEventListener("click", event => {
      event.preventDefault();
      const page = link.dataset.nav;
      if (window.location.hash !== "#" + page) window.location.hash = page;
      show(page);
      window.scrollTo(0, 0);
    });
  }
  window.addEventListener("hashchange", fromHash);
  fromHash();
})();
