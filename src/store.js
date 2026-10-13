// Saved settings (state.json). Written atomically so a crash can never leave a half-written file.
const fs = require("node:fs");

function createStore(file, defaults, log = () => {}) {
  const state = { ...defaults };
  try {
    Object.assign(state, JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {}

  function save() {
    try {
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      log("Could not save state:", e.message);
    }
  }

  return { state, save };
}

module.exports = { createStore };
