"use strict";

const {
  runVaultRotationCli
} = require("../src/social/vault-key-rotation-operator");

if (require.main === module) {
  runVaultRotationCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = { runVaultRotationCli };
