// Replace with your real stock data / feed.
const STOCK = {
  "MINI": ["Hatch", "Convertible", "Clubman", "Countryman", "Electric", "John Cooper Works"],
  "BMW": ["1 Series", "2 Series", "3 Series", "X1"],
  "Audi": ["A1", "A3", "Q2"],
  "Ford": ["Fiesta", "Focus"],
  "Volkswagen": ["Polo", "Golf"]
};
const PRICES = [5000, 7500, 10000, 12500, 15000, 20000, 25000, 30000];
const FINANCE = [100, 150, 200, 250, 300, 400, 500];

const $ = (id) => document.getElementById(id);
const make = $("make"), model = $("model"), max = $("max"), label = $("maxLabel");
let mode = "price";

const fill = (el, first, items) => {
  el.innerHTML = `<option value="">${first}</option>` + items.map((v) => `<option>${v}</option>`).join("");
};

Object.keys(STOCK).forEach((m) => make.add(new Option(m, m)));
make.options[0].text = `Any make (${Object.keys(STOCK).length})`;

make.addEventListener("change", () => {
  const models = STOCK[make.value] || [];
  fill(model, "Any model", models);
  model.disabled = !models.length;
});

function renderMax() {
  if (mode === "price") {
    label.textContent = "Maximum price";
    max.innerHTML = '<option value="">Price (max)</option>' + PRICES.map((p) => `<option value="${p}">Up to £${p.toLocaleString("en-GB")}</option>`).join("");
  } else {
    label.textContent = "Maximum monthly payment";
    max.innerHTML = '<option value="">Per month (max)</option>' + FINANCE.map((p) => `<option value="${p}">Up to £${p}/month</option>`).join("");
  }
}
renderMax();

document.querySelectorAll(".toggle button").forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.mode;
    document.querySelectorAll(".toggle button").forEach((x) => x.classList.toggle("is-on", x === b));
    renderMax();
  })
);

const burger = $("burger"), menu = $("menu");
burger.addEventListener("click", () => {
  const open = menu.classList.toggle("is-open");
  burger.setAttribute("aria-expanded", open);
});
menu.addEventListener("click", (e) => { if (e.target.tagName === "A") { menu.classList.remove("is-open"); burger.setAttribute("aria-expanded", false); } });

$("yr").textContent = new Date().getFullYear();
