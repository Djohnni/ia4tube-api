"use strict";

const {
  FcmFinalTestError,
  assertFinalTestProductionInvariants,
  assertFinalTestSendGates,
  safeFinalTestOutput
} = require("./fcm-final-test");

function assertNoArguments(argv = []) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new FcmFinalTestError(
      "fcm_final_test_argument_invalid"
    );
  }
  return true;
}

function requiredProductionDataDir(env = process.env) {
  return assertFinalTestProductionInvariants(env);
}

async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  output = process.stdout
} = {}) {
  try {
    assertNoArguments(argv);
    const eventId = String(env.FCM_FINAL_TEST_EVENT_ID || "");
    const pedidoId = String(env.FCM_FINAL_TEST_PEDIDO_ID || "");
    const ownerId = String(env.FCM_FINAL_TEST_OWNER_ID || "");
    requiredProductionDataDir(env);
    assertFinalTestSendGates(env);

    // Carregado somente dentro do bloco protegido para impedir stack trace
    // caso a configuracao Firebase falhe fechada durante a inicializacao.
    const fcmService = require("./fcm.service");
    const result = await fcmService.runFinalTestArtReady({
      ownerId,
      eventId,
      pedidoId
    });
    output.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    output.write(`${JSON.stringify(safeFinalTestOutput(error))}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  assertNoArguments,
  requiredProductionDataDir,
  runCli
};
