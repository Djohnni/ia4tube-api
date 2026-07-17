const path = require("path");

const storage = require("./free-art-campaigns.storage");

function orderReady({ pedidosDir, whatsapp, mes, pedidoId }) {
  return Boolean(
    whatsapp &&
    mes &&
    pedidoId &&
    require("fs").existsSync(path.join(pedidosDir, whatsapp, mes, pedidoId, "resultado_final.png"))
  );
}

async function processDueNotifications({
  baseDir,
  pedidosDir,
  clientes = {},
  now = new Date(),
  sendNotification,
  limit = 100
}) {
  const max = Math.max(1, Math.min(Number(limit) || 100, 500));
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const result = {
    ok: true,
    checked: 0,
    sent: 0,
    errors: 0,
    skipped: 0,
    mock: 0
  };

  if (typeof sendNotification !== "function") {
    return { ...result, ok: false, error: "sendNotification callback obrigatorio" };
  }

  for (const campaign of storage.listCampaigns(baseDir)) {
    if (result.checked >= max) break;
    if (campaign.status !== "distribuida") continue;

    const distribution = storage.readDistribution(baseDir, campaign.id);
    let changed = false;

    for (const assignment of distribution.assignments || []) {
      if (result.checked >= max) break;
      const status = String(assignment.notificacao_status || "").toLowerCase();
      if (["enviada", "cancelada", "erro", "sem_data"].includes(status)) continue;

      const notifyAt = new Date(assignment.notificar_em || "").getTime();
      if (!Number.isFinite(notifyAt) || Number.isNaN(notifyAt)) {
        assignment.notificacao_status = "erro";
        assignment.notificacao_erro = "notificar_em_invalido";
        result.errors += 1;
        changed = true;
        continue;
      }

      if (notifyAt > nowTime) continue;

      if (!orderReady({
        pedidosDir,
        whatsapp: assignment.whatsapp,
        mes: assignment.mes,
        pedidoId: assignment.pedido_id
      })) {
        result.skipped += 1;
        continue;
      }

      result.checked += 1;
      assignment.notificacao_tentativas = Number(assignment.notificacao_tentativas || 0) + 1;

      try {
        const cliente = clientes[assignment.whatsapp] || {};
        const sendResult = await sendNotification({
          cliente,
          campaign,
          assignment
        });

        if (!sendResult?.ok) {
          assignment.notificacao_status = "erro";
          assignment.notificacao_erro = sendResult?.error || sendResult?.code || "falha_envio_fcm";
          assignment.notificacao_resultado = sendResult || {};
          result.errors += 1;
        } else {
          assignment.notificacao_status = "enviada";
          assignment.notificacao_enviada_em = new Date(nowTime).toISOString();
          assignment.notificacao_erro = "";
          assignment.notificacao_resultado = sendResult || {};
          result.sent += 1;
          if (sendResult.mock) result.mock += 1;
        }
      } catch (error) {
        assignment.notificacao_status = "erro";
        assignment.notificacao_erro = error?.message || "falha_envio_fcm";
        result.errors += 1;
      }

      changed = true;
    }

    if (changed) {
      distribution.updated_at = new Date(nowTime).toISOString();
      storage.writeDistribution(baseDir, campaign.id, distribution);
      storage.appendAudit(baseDir, campaign.id, {
        action: "notification_scheduler",
        sent: result.sent,
        errors: result.errors,
        skipped: result.skipped
      });
    }
  }

  return result;
}

module.exports = {
  processDueNotifications
};
