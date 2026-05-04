(() => {
  const links = document.querySelectorAll("[data-nav]");
  if (!links.length) return;

  links.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      links.forEach((l) => l.classList.remove("is-active"));
      link.classList.add("is-active");
    });
  });
})();
