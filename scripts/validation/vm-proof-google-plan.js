"use strict";
// Offline contract only. Importing/preparing never authenticates or creates.
const { MANIFEST, canonical, sha256 } = require("./vm-proof-manifest");
const net = require("node:net");
const PACKAGE = "e81b4d31d4fb0d1f861f439b72cca0e919cf89202ee093205e7c719c09c6e416";
const IMAGE = "projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260906";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KINDS = Object.freeze(["networks", "subnetworks", "firewalls", "instances", "disks"]);
function fail(code) { throw Object.assign(new Error("gcp_proof_" + code), { code: "gcp_proof_" + code }); }
function googleId(v) {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,19}$/.test(v) || BigInt(v) > 18446744073709551615n) fail("id_invalid");
  return v;
}
function ipv4(v) {
  if (net.isIP(v) !== 4) fail("operator_ip_invalid");
  const [a,b] = v.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0,168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b))) fail("operator_ip_invalid");
  return v;
}
function createGooglePlan({ imageId = null, operatorIpv4 = null, resolution = null } = {}) {
  if (imageId !== null) googleId(imageId);
  if (operatorIpv4 !== null) ipv4(operatorIpv4);
  const content = {
    schema: 2, provider: "google", kind: "ia4tube-google-synthetic-proof", paidExecutionDefault: false,
    project: "ia4tube-futebol", region: "us-central1", zone: "us-central1-a",
    machineType: "e2-medium", visibleVcpus: 2, sustainedVcpuFraction: 1, memoryMiB: 4096,
    sourceImage: IMAGE, sourceImageId: imageId, packageSha256: PACKAGE,
    diskType: "pd-standard", diskGiB: 50, autoDeleteDisk: true,
    networkMode: "dedicated-custom", subnetCidr: "10.203.0.0/28", operatorIpv4,
    firewallPort: 22, maxExistenceSeconds: 7200, terminationAction: "DELETE",
    provisioningModel: "STANDARD", onHostMaintenance: "MIGRATE", automaticRestart: false,
    createRetries: 0, launchRetries: 0, cases: MANIFEST.cases,
    finance: { computeHourlyUsd: 0.03350571, diskGiBHourlyUsd: 0.000054795, ipv4HourlyUsd: 0.005,
      twoHourInfrastructureUsd: 0.08249092, referenceUsd: 0.11, invoiceCapGuaranteed: false },
    serviceAccounts: [], realMedia: false, apiDeploy: false, remoteMigrations: false,
    backups: false, snapshots: false, recurring: false, instagram: false
  };
  if (resolution !== null) {
    if (Object.keys(resolution).sort().join(',') !== 'authorizationSha256,packageReviewSha256,packageSha256' ||
        Object.values(resolution).some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) fail('resolution_binding_invalid');
    content.schema = 3;
    content.kind = 'ia4tube-google-synthetic-resolution';
    content.packageSha256 = resolution.packageSha256;
    content.resolution = { ...resolution, maxInstallInvocations: 3, maxAdditionalLaunches: 8,
      cleanupReserveSeconds: 600, uncertainReplay: false, secondVm: false };
  }
  return { ...content, approvalSha256: sha256(canonical(content)) };
}
function validateGooglePlan(plan, { executable = false } = {}) {
  const resolution = plan?.schema === 3 ? {
    packageSha256: plan?.resolution?.packageSha256, packageReviewSha256: plan?.resolution?.packageReviewSha256,
    authorizationSha256: plan?.resolution?.authorizationSha256
  } : null;
  const expected = createGooglePlan({ imageId: plan?.sourceImageId, operatorIpv4: plan?.operatorIpv4, resolution });
  if (canonical(expected) !== canonical(plan)) fail("plan_changed");
  if (executable && (plan.sourceImageId === null || plan.operatorIpv4 === null)) fail("read_bindings_missing");
  return plan;
}
function scope(plan, kind) {
  if (!KINDS.includes(kind)) fail("kind_invalid");
  return `projects/${plan.project}/` + (kind === "subnetworks" ? `regions/${plan.region}` : ["instances","disks"].includes(kind) ? `zones/${plan.zone}` : "global");
}
function resourceName(missionId, kind) {
  if (!UUID.test(missionId) || !KINDS.includes(kind)) fail("mission_invalid");
  return "ia4proof-" + missionId + "-" + ({ networks:"net", subnetworks:"subnet", firewalls:"ssh", instances:"vm", disks:"boot" })[kind];
}
function resourcePath(plan, missionId, kind) { return `${scope(plan, kind)}/${kind}/${resourceName(missionId, kind)}`; }
function description(plan, missionId) { return `iA4tube synthetic proof ${missionId} plan ${plan.approvalSha256}`; }
function relativeLink(value) {
  if (typeof value !== "string") fail("link_invalid");
  const s = value.replace(/^https:\/\/(?:www\.googleapis\.com|compute\.googleapis\.com)\/compute\/v1\//, "");
  if (!/^projects\/[a-z0-9-]+\/(?:zones\/[a-z0-9-]+|regions\/[a-z0-9-]+|global)\/[A-Za-z]+\/[a-z0-9-]+$/.test(s)) fail("link_invalid");
  return s;
}
function bodyFor(plan, state, kind, startupScript) {
  validateGooglePlan(plan, { executable: true });
  if (!Number.isSafeInteger(state.startedAt) || state.deadlineAt !== state.startedAt + plan.maxExistenceSeconds * 1000) fail("absolute_deadline_invalid");
  const name = resourceName(state.missionId, kind), descriptionText = description(plan, state.missionId);
  const link = k => resourcePath(plan, state.missionId, k);
  const common = { name, description: descriptionText };
  if (kind === "networks") return { ...common, autoCreateSubnetworks: false, routingConfig: { routingMode: "REGIONAL" } };
  if (kind === "subnetworks") return { ...common, network: link("networks"), ipCidrRange: plan.subnetCidr, privateIpGoogleAccess: false, stackType: "IPV4_ONLY" };
  if (kind === "firewalls") return { ...common, network: link("networks"), direction: "INGRESS", priority: 1000,
    sourceRanges: [plan.operatorIpv4 + "/32"], targetTags: [resourceName(state.missionId,"instances")], allowed: [{ IPProtocol: "tcp", ports: ["22"] }], disabled: false };
  if (kind !== "instances" || typeof startupScript !== "string" || !startupScript.startsWith("#!/bin/bash\n# iA4tube Google proof bootstrap\n") || startupScript.length > 16000 || !Number.isSafeInteger(state.deadlineAt)) fail("bootstrap_invalid");
  return { ...common, machineType: `zones/${plan.zone}/machineTypes/${plan.machineType}`, canIpForward: false,
    deletionProtection: false, serviceAccounts: [], tags: { items: [name] },
    disks: [{ boot: true, autoDelete: true, mode: "READ_WRITE", type: "PERSISTENT", deviceName: resourceName(state.missionId,"disks"),
      initializeParams: { diskName: resourceName(state.missionId,"disks"), diskSizeGb: "50", diskType: `zones/${plan.zone}/diskTypes/pd-standard`,
        sourceImage: plan.sourceImage, description: descriptionText, resourcePolicies: [] } }],
    networkInterfaces: [{ network: link("networks"), subnetwork: link("subnetworks"), stackType: "IPV4_ONLY",
      accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT", networkTier: "PREMIUM" }] }],
    scheduling: { provisioningModel: plan.provisioningModel, automaticRestart: plan.automaticRestart, onHostMaintenance: plan.onHostMaintenance,
      terminationTime: new Date(state.deadlineAt).toISOString(), instanceTerminationAction: "DELETE" },
    shieldedInstanceConfig: { enableSecureBoot: true, enableVtpm: true, enableIntegrityMonitoring: true },
    metadata: { items: [
      { key: "block-project-ssh-keys", value: "TRUE" }, { key: "enable-oslogin", value: "FALSE" },
      { key: "serial-port-enable", value: "FALSE" }, { key: "enable-osconfig", value: "FALSE" },
      { key: "startup-script-url", value: "" }, { key: "shutdown-script", value: "" }, { key: "shutdown-script-url", value: "" },
      { key: "startup-script", value: startupScript }
    ] }
  };
}
function bindResource(plan, state, kind, resource, { strict = false } = {}) {
  const record = state.resources[kind];
  if (!record || record.intentAt === null || !resource) fail("resource_not_owned");
  const id = googleId(resource.id), created = Date.parse(resource.creationTimestamp);
  if (resource.name !== resourceName(state.missionId,kind) || relativeLink(resource.selfLink) !== resourcePath(plan,state.missionId,kind) ||
      resource.description !== description(plan,state.missionId) || state.preexisting[kind].some(r=>r.id === id || r.name === resource.name) ||
      !Number.isFinite(created) || created < record.intentAt - 30000 || created > state.deadlineAt ||
      (record.id !== null && record.id !== id) || (record.createdAt !== null && record.createdAt !== created)) fail("resource_identity_mismatch");
  if (strict) {
    if (kind === "networks" && resource.autoCreateSubnetworks !== false) fail("network_configuration_mismatch");
    if (kind === "subnetworks" && (relativeLink(resource.network) !== resourcePath(plan,state.missionId,"networks") || resource.ipCidrRange !== plan.subnetCidr)) fail("subnet_configuration_mismatch");
    if (kind === "firewalls" && (relativeLink(resource.network) !== resourcePath(plan,state.missionId,"networks") || resource.direction !== "INGRESS" ||
        canonical(resource.sourceRanges) !== canonical([plan.operatorIpv4+"/32"]) || canonical(resource.allowed) !== canonical([{ IPProtocol:"tcp", ports:["22"] }]) ||
        canonical(resource.targetTags) !== canonical([resourceName(state.missionId,"instances")]) || resource.disabled === true)) fail("firewall_configuration_mismatch");
    if (kind === "disks" && (String(resource.sizeGb) !== "50" || relativeLink(resource.type) !== `projects/${plan.project}/zones/${plan.zone}/diskTypes/pd-standard` ||
        relativeLink(resource.sourceImage) !== plan.sourceImage || resource.sourceImageId !== plan.sourceImageId || (resource.resourcePolicies || []).length)) fail("disk_configuration_mismatch");
    if (kind === "instances") {
      const disk = resource.disks?.[0], nic = resource.networkInterfaces?.[0], sched = resource.scheduling;
      const metadata=resource.metadata?.items||[], values=Object.fromEntries(metadata.map(v=>[v.key,v.value]));
      if(metadata.length!==Object.keys(values).length || values["block-project-ssh-keys"]!=="TRUE" ||
          ["enable-oslogin","serial-port-enable","enable-osconfig"].some(k=>values[k]!=="FALSE") ||
          ["startup-script-url","shutdown-script","shutdown-script-url"].some(k=>values[k]!=="") ||
          typeof values["startup-script"]!=="string" || sha256(values["startup-script"])!==record.bootstrapSha256 ||
          resource.shieldedInstanceConfig?.enableSecureBoot!==true || resource.shieldedInstanceConfig?.enableVtpm!==true ||
          resource.shieldedInstanceConfig?.enableIntegrityMonitoring!==true)fail("instance_bootstrap_mismatch");
      if (relativeLink(resource.machineType) !== `projects/${plan.project}/zones/${plan.zone}/machineTypes/e2-medium` ||
          resource.disks?.length !== 1 || disk.boot !== true || disk.autoDelete !== true || relativeLink(disk.source) !== resourcePath(plan,state.missionId,"disks") ||
          (resource.serviceAccounts || []).length || resource.canIpForward === true || resource.deletionProtection === true ||
          resource.networkInterfaces?.length !== 1 || relativeLink(nic.network) !== resourcePath(plan,state.missionId,"networks") ||
          relativeLink(nic.subnetwork) !== resourcePath(plan,state.missionId,"subnetworks") || nic.accessConfigs?.length !== 1 ||
          nic.stackType!=="IPV4_ONLY" || (nic.ipv6AccessConfigs||[]).length ||
          sched?.provisioningModel!=="STANDARD" || sched.onHostMaintenance!=="MIGRATE" ||
          sched?.instanceTerminationAction !== "DELETE" || Date.parse(sched.terminationTime) !== state.deadlineAt || sched.automaticRestart !== false) fail("instance_configuration_mismatch");
    }
  }
  return { id, createdAt: created };
}
module.exports = { PACKAGE, IMAGE, UUID, KINDS, fail, googleId, ipv4, createGooglePlan, validateGooglePlan, scope, resourceName, resourcePath, relativeLink, description, bodyFor, bindResource };
