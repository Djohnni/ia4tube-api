// Rebuilds banco_modelos/index.json from curated metadata.json files.
const storage = require("./modelo.storage");

function rebuildModelosIndex(dirPath) {
  return storage.buildIndex(dirPath);
}

if (require.main === module) {
  const index = rebuildModelosIndex();
  console.log(JSON.stringify({
    ok: true,
    total_modelos_ativos: index.total_modelos_ativos,
    gerado_em: index.gerado_em
  }, null, 2));
}

module.exports = {
  rebuildModelosIndex
};
