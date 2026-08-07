"use strict";

const crypto = require("node:crypto");

const FIREWALL_EVIDENCE_MODE = "loopback_nonmutation_v1";
const FIREWALL_EVIDENCE_SCOPE = "social_3a0p_local_windows_disposable";
const LOOPBACK_HOST = "127.0.0.1";
const CONTRACT_VERSION = 1;

const COMPONENT_NAMES = Object.freeze([
  "profiles",
  "globalSettings",
  "rulesMetadata"
]);

const PROFILE_FIELDS = Object.freeze([
  "name",
  "enabled",
  "defaultInboundAction",
  "defaultOutboundAction"
]);

const GLOBAL_SETTING_FIELDS = Object.freeze([
  "exemptions",
  "enableStatefulFtp",
  "enableStatefulPptp",
  "requireFullAuthSupport",
  "certValidationLevel",
  "allowIpsecThroughNat",
  "maxSaIdleTimeSeconds",
  "keyEncoding",
  "enablePacketQueuing"
]);

const RULE_FIELDS = Object.freeze([
  "name",
  "enabled",
  "direction",
  "action",
  "profile",
  "policyStoreSourceType"
]);

class FirewallNonmutationFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "FirewallNonmutationFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new FirewallNonmutationFailure(code);
}

function plainObject(value, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  plainObject(value, code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
  return value;
}

function canonicalScalar(value, code) {
  if (typeof value === "string") {
    if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) fail(code);
    return value.normalize("NFC");
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  fail(code);
}

function canonicalRecord(value, fields, code) {
  exactKeys(value, fields, code);
  return Object.freeze(Object.fromEntries(
    fields.map((field) => [field, canonicalScalar(value[field], code)])
  ));
}

function canonicalizeUniqueRows(rows, fields, identityField, code) {
  if (!Array.isArray(rows) || rows.length < 1) fail(code);
  const normalized = rows.map((row) => canonicalRecord(row, fields, code));
  normalized.sort((left, right) => String(left[identityField]).localeCompare(
    String(right[identityField]),
    "en",
    { sensitivity: "variant", usage: "sort" }
  ));
  const identities = new Set();
  for (const row of normalized) {
    const identity = String(row[identityField]).toLowerCase();
    if (identities.has(identity)) fail(`${code}_duplicate_identity`);
    identities.add(identity);
  }
  return Object.freeze(normalized);
}

function canonicalizeFirewallProfiles(rows) {
  return canonicalizeUniqueRows(
    rows,
    PROFILE_FIELDS,
    "name",
    "firewall_nonmutation_profiles_invalid"
  );
}

function canonicalizeFirewallGlobalSettings(value) {
  return canonicalRecord(
    value,
    GLOBAL_SETTING_FIELDS,
    "firewall_nonmutation_global_settings_invalid"
  );
}

function canonicalizeFirewallRules(rows) {
  return canonicalizeUniqueRows(
    rows,
    RULE_FIELDS,
    "name",
    "firewall_nonmutation_rules_invalid"
  );
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function component(componentName, canonicalValue, objectCount) {
  if (!COMPONENT_NAMES.includes(componentName)) {
    fail("firewall_nonmutation_component_name_invalid");
  }
  if (!Number.isSafeInteger(objectCount) || objectCount < 1) {
    fail("firewall_nonmutation_component_count_invalid");
  }
  return Object.freeze({
    componentName,
    objectCount,
    sha256: sha256Json(canonicalValue)
  });
}

function aggregateManifest(components) {
  return {
    contractVersion: CONTRACT_VERSION,
    firewallEvidenceMode: FIREWALL_EVIDENCE_MODE,
    components: components.map((entry) => ({
      componentName: entry.componentName,
      objectCount: entry.objectCount,
      sha256: entry.sha256
    }))
  };
}

function buildFirewallLightEvidence({ profiles, globalSettings, rules }) {
  const canonicalProfiles = canonicalizeFirewallProfiles(profiles);
  const canonicalGlobalSettings = canonicalizeFirewallGlobalSettings(globalSettings);
  const canonicalRules = canonicalizeFirewallRules(rules);
  const components = Object.freeze([
    component("profiles", canonicalProfiles, canonicalProfiles.length),
    component("globalSettings", canonicalGlobalSettings, 1),
    component("rulesMetadata", canonicalRules, canonicalRules.length)
  ]);
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    firewallEvidenceMode: FIREWALL_EVIDENCE_MODE,
    processElevated: false,
    currentUserResolved: true,
    integrityNonAdministrative: true,
    components,
    aggregateSha256: sha256Json(aggregateManifest(components))
  });
}

function validateComponent(value, expectedName) {
  exactKeys(
    value,
    ["componentName", "objectCount", "sha256"],
    "firewall_nonmutation_component_invalid"
  );
  if (
    value.componentName !== expectedName ||
    !Number.isSafeInteger(value.objectCount) ||
    value.objectCount < 1 ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    fail("firewall_nonmutation_component_invalid");
  }
  return Object.freeze({
    componentName: value.componentName,
    objectCount: value.objectCount,
    sha256: value.sha256
  });
}

function validateFirewallLightEvidence(value) {
  exactKeys(
    value,
    [
      "contractVersion",
      "firewallEvidenceMode",
      "processElevated",
      "currentUserResolved",
      "integrityNonAdministrative",
      "components",
      "aggregateSha256"
    ],
    "firewall_nonmutation_evidence_invalid"
  );
  if (
    value.contractVersion !== CONTRACT_VERSION ||
    value.firewallEvidenceMode !== FIREWALL_EVIDENCE_MODE ||
    value.processElevated !== false ||
    value.currentUserResolved !== true ||
    value.integrityNonAdministrative !== true ||
    !Array.isArray(value.components) ||
    value.components.length !== COMPONENT_NAMES.length ||
    !/^[0-9a-f]{64}$/.test(value.aggregateSha256)
  ) {
    fail("firewall_nonmutation_evidence_invalid");
  }
  const components = Object.freeze(value.components.map((entry, index) =>
    validateComponent(entry, COMPONENT_NAMES[index])));
  const expectedAggregate = sha256Json(aggregateManifest(components));
  if (expectedAggregate !== value.aggregateSha256) {
    fail("firewall_nonmutation_aggregate_invalid");
  }
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    firewallEvidenceMode: FIREWALL_EVIDENCE_MODE,
    processElevated: false,
    currentUserResolved: true,
    integrityNonAdministrative: true,
    components,
    aggregateSha256: value.aggregateSha256
  });
}

function compareFirewallLightEvidence(beforeValue, afterValue) {
  const before = validateFirewallLightEvidence(beforeValue);
  const after = validateFirewallLightEvidence(afterValue);
  const componentEqual = Object.fromEntries(COMPONENT_NAMES.map((name, index) => {
    const left = before.components[index];
    const right = after.components[index];
    return [name, left.objectCount === right.objectCount && left.sha256 === right.sha256];
  }));
  let divergentComponent = null;
  for (let index = 0; index < COMPONENT_NAMES.length; index += 1) {
    if (componentEqual[COMPONENT_NAMES[index]] !== true) {
      divergentComponent = COMPONENT_NAMES[index];
      break;
    }
  }
  if (!divergentComponent && before.aggregateSha256 !== after.aggregateSha256) {
    divergentComponent = "aggregate";
  }
  const equal = divergentComponent === null;
  return Object.freeze({
    equal,
    divergentComponent,
    fullFirewallFilterSnapshotProved: false,
    firewallProfilesAndRulesMetadataStable:
      componentEqual.profiles === true && componentEqual.rulesMetadata === true,
    firewallGlobalSettingsStable: componentEqual.globalSettings === true,
    firewallLightAggregateStable:
      before.aggregateSha256 === after.aggregateSha256
  });
}

function validateLoopbackNonmutationContext(value) {
  exactKeys(
    value,
    ["mode", "platform", "scope", "host", "processElevated"],
    "firewall_nonmutation_context_invalid"
  );
  if (value.mode !== FIREWALL_EVIDENCE_MODE) {
    fail("firewall_nonmutation_mode_refused");
  }
  if (value.platform !== "win32") fail("firewall_nonmutation_platform_refused");
  if (value.scope !== FIREWALL_EVIDENCE_SCOPE) {
    fail("firewall_nonmutation_scope_refused");
  }
  if (value.host !== LOOPBACK_HOST) fail("firewall_nonmutation_host_refused");
  if (value.processElevated !== false) {
    fail("firewall_nonmutation_elevated_refused");
  }
  return Object.freeze({
    mode: FIREWALL_EVIDENCE_MODE,
    platform: "win32",
    scope: FIREWALL_EVIDENCE_SCOPE,
    host: LOOPBACK_HOST,
    processNonElevated: true
  });
}

function mutationPatternGroups() {
  // Keep the detector's own source from containing a complete forbidden
  // command. This module is included in the executable-source proof too.
  const firewallNoun = "NetFire" + "wall";
  const advfirewall = "adv" + "firewall";
  const policyCom = "HNetCfg" + ".FwPolicy2";
  const policyInterface = "INetFw" + "Policy2";
  const registryPolicyNoun = "Firewall" + "Policy";
  const groupPolicyFirewallNoun = "Windows" + "Firewall";
  const startProcess = "Start-" + "Process";
  const elevationVerb = "Run" + "As";
  const runasExecutable = "run" + "as";
  const scheduledTask = "Scheduled" + "Task";
  const serviceNoun = "Ser" + "vice";
  const localUser = "Local" + "User";
  const localGroupMember = "LocalGroup" + "Member";
  const encodedCommand = "Encoded" + "Command";
  const groupPolicyRegistry = "GPRegistry" + "Value";
  const postgresControl = "pg_" + "ctl";
  return Object.freeze({
    firewall: Object.freeze([
      new RegExp(`\\b(?:New|Set|Remove|Enable|Disable|Rename|Copy)-${firewallNoun}[A-Za-z0-9_-]*\\b`, "i"),
      new RegExp(`\\bnetsh(?:\\.exe)?\\b[^\\r\\n]{0,200}\\b${advfirewall}\\b[^\\r\\n]{0,200}\\b(?:add|set|delete|reset|import)\\b`, "i"),
      new RegExp(`\\b(?:New|Set|Remove)-CimInstance\\b[^\\r\\n]{0,300}\\bMSFT_${firewallNoun}`, "i"),
      new RegExp(`\\bMSFT_${firewallNoun}[^\\r\\n]{0,300}\\b(?:New|Set|Remove)-CimInstance\\b`, "i"),
      new RegExp(`\\bInvoke-CimMethod\\b[^\\r\\n]{0,300}\\bMSFT_${firewallNoun}`, "i"),
      new RegExp(policyCom.replace(".", "\\."), "i"),
      new RegExp(policyInterface, "i"),
      /\.Rules\s*\.\s*(?:Add|Remove)\s*\(/i,
      new RegExp(`\\b(?:New|Set|Remove)-Item(?:Property)?\\b[^\\r\\n]{0,300}\\b${registryPolicyNoun}\\b`, "i"),
      new RegExp(`\\b${registryPolicyNoun}\\b[^\\r\\n]{0,300}\\b(?:New|Set|Remove)-Item(?:Property)?\\b`, "i"),
      new RegExp(`\\breg(?:\\.exe)?\\b[^\\r\\n]{0,300}\\b(?:add|delete)\\b[^\\r\\n]{0,300}\\b${registryPolicyNoun}\\b`, "i"),
      new RegExp(`\\bSet-${groupPolicyRegistry}\\b[^\\r\\n]{0,300}\\b(?:${registryPolicyNoun}|${groupPolicyFirewallNoun})\\b`, "i")
    ]),
    uacElevation: Object.freeze([
      new RegExp(`\\b${startProcess}\\b[\\s\\S]{0,300}(?:^|\\s)-Verb\\s+['"]?${elevationVerb}\\b['"]?`, "i"),
      new RegExp(`(?:^|\\s)-Verb\\s+['"]?${elevationVerb}\\b['"]?[\\s\\S]{0,300}\\b${startProcess}\\b`, "i"),
      new RegExp(`(?:^|\\s)-Verb\\s+['"]?${elevationVerb}\\b['"]?`, "i"),
      new RegExp(`\\.Verb\\s*=\\s*['"]?${elevationVerb}\\b['"]?`, "i"),
      new RegExp(`\\b${runasExecutable}(?:\\.exe)?\\b`, "i"),
      new RegExp(`\\bShellExecute\\b[\\s\\S]{0,1000}\\b${runasExecutable}\\b`, "i"),
      new RegExp(`\\b${startProcess}\\b[\\s\\S]{0,300}(?:^|\\s)-Credential\\b`, "i"),
      new RegExp(`(?:^|\\s)-Credential\\b[\\s\\S]{0,300}\\b${startProcess}\\b`, "i"),
      new RegExp(`\\bpowershell(?:\\.exe)?\\b[^\\r\\n]{0,300}(?:^|\\s)-(?:enc|${encodedCommand})\\b`, "i"),
      new RegExp(`\\bpwsh(?:\\.exe)?\\b[^\\r\\n]{0,300}(?:^|\\s)-(?:enc|${encodedCommand})\\b`, "i")
    ]),
    scheduledTask: Object.freeze([
      new RegExp(`\\b(?:New|Set|Register|Unregister|Enable|Disable|Start|Stop)-${scheduledTask}\\b`, "i"),
      /\bschtasks(?:\.exe)?\b[^\r\n]{0,300}\/(?:create|change|delete|run|end)\b/i
    ]),
    service: Object.freeze([
      new RegExp(`\\b(?:New|Set|Remove|Start|Stop|Restart|Suspend|Resume)-${serviceNoun}\\b`, "i"),
      /\bsc(?:\.exe)?\b[^\r\n]{0,300}\b(?:create|delete|config|start|stop|pause|continue)\b/i,
      /\bnet(?:\.exe)?\s+(?:start|stop)\b/i,
      new RegExp(`\\b${postgresControl}(?:\\.exe)?\\b[^\\r\\n]{0,300}\\b(?:register|unregister)\\b`, "i")
    ]),
    localUser: Object.freeze([
      new RegExp(`\\b(?:New|Set|Remove|Enable|Disable|Rename)-${localUser}\\b`, "i"),
      new RegExp(`\\b(?:Add|Remove)-${localGroupMember}\\b`, "i"),
      /\bnet(?:\.exe)?\s+user\b/i,
      /\bnet(?:\.exe)?\s+localgroup\b[^\r\n]{0,300}\/(?:add|delete)\b/i
    ])
  });
}

function assertExecutableFirewallNonmutation(entries) {
  if (!Array.isArray(entries) || entries.length < 1) {
    fail("firewall_nonmutation_executable_sources_invalid");
  }
  let executableCount = 0;
  const patternGroups = mutationPatternGroups();
  for (const entry of entries) {
    exactKeys(
      entry,
      ["sourceId", "executable", "source"],
      "firewall_nonmutation_executable_source_invalid"
    );
    if (
      typeof entry.sourceId !== "string" ||
      !/^[a-z][a-z0-9._:/-]{2,159}$/.test(entry.sourceId) ||
      typeof entry.executable !== "boolean" ||
      typeof entry.source !== "string" ||
      entry.source.includes("\0")
    ) {
      fail("firewall_nonmutation_executable_source_invalid");
    }
    if (entry.executable === false) {
      if (!entry.sourceId.startsWith("fixture:")) {
        fail("firewall_nonmutation_nonexecutable_source_invalid");
      }
      continue;
    }
    executableCount += 1;
    if (Object.values(patternGroups).some((patterns) =>
      patterns.some((pattern) => pattern.test(entry.source)))) {
      fail("firewall_nonmutation_mutation_command_refused");
    }
  }
  if (executableCount < 1) {
    fail("firewall_nonmutation_executable_source_missing");
  }
  return Object.freeze({
    firewallMutationCommandsAbsent: true,
    uacElevationCommandsAbsent: true,
    scheduledTaskMutationCommandsAbsent: true,
    serviceMutationCommandsAbsent: true,
    localUserMutationCommandsAbsent: true,
    executableSourcesChecked: executableCount
  });
}

function proveLoopbackNonmutationExecutablePath({ sources = [], command } = {}) {
  if (!Array.isArray(sources) || typeof command !== "string" || !command) {
    fail("firewall_nonmutation_executable_path_invalid");
  }
  return assertExecutableFirewallNonmutation([
    { sourceId: "firewall:active-command", executable: true, source: command },
    ...sources
  ]);
}

function firewallLightEvidencePowerShell() {
  return [
    "$ErrorActionPreference='Stop';",
    "$identity=[Security.Principal.WindowsIdentity]::GetCurrent();",
    "$principal=New-Object Security.Principal.WindowsPrincipal($identity);",
    "$elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);",
    "if($elevated){throw 'firewall_nonmutation_elevated_refused'};",
    "$whoami=Join-Path $env:SystemRoot 'System32\\whoami.exe';if(-not(Test-Path -LiteralPath $whoami -PathType Leaf)){throw 'firewall_nonmutation_integrity_unavailable'};",
    "$groups=@(& $whoami /groups /fo csv /nh|ConvertFrom-Csv -Header Name,Type,Sid,Attributes);$labels=@($groups|Where-Object{$_.Sid -like 'S-1-16-*'}|ForEach-Object{[int]($_.Sid.Split('-')[-1])});if($labels.Count -ne 1 -or $labels[0] -ge 12288){throw 'firewall_nonmutation_integrity_refused'};",
    "function Get-Ia4Hash([string]$text){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}};",
    "function Convert-Ia4CanonicalSettingValue([object]$value){if($null-eq$value){throw 'firewall_nonmutation_property_invalid'};if($value-is[string]-or-not($value-is[Collections.IEnumerable])){$text=[string]$value;if([string]::IsNullOrWhiteSpace($text)-or$text.Contains([char]0)-or$text.Contains([char]13)-or$text.Contains([char]10)){throw 'firewall_nonmutation_property_invalid'};return $text};$items=[Collections.Generic.List[string]]::new();foreach($item in $value){if($null-eq$item){throw 'firewall_nonmutation_property_invalid'};$text=[string]$item;if([string]::IsNullOrWhiteSpace($text)-or$text.Contains([char]0)-or$text.Contains([char]13)-or$text.Contains([char]10)){throw 'firewall_nonmutation_property_invalid'};$items.Add($text)};if($items.Count-lt1){throw 'firewall_nonmutation_property_invalid'};$ordered=[string[]]$items.ToArray();[Array]::Sort($ordered,[StringComparer]::Ordinal);return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject ([object[]]$ordered) -Compress)))};",
    "function Assert-Ia4Record([Collections.IDictionary]$record,[string[]]$fields){foreach($field in $fields){if(-not $record.Contains($field)){throw 'firewall_nonmutation_property_missing'};$value=$record[$field];if($null -eq $value){throw 'firewall_nonmutation_property_invalid'};if($value -is [string]){if([string]::IsNullOrWhiteSpace($value)-or$value.Contains([char]0)-or$value.Contains([char]13)-or$value.Contains([char]10)){throw 'firewall_nonmutation_property_invalid'}}};return $record};",
    "$profiles=@(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop|ForEach-Object{$row=[ordered]@{name=[string]$_.Name;enabled=[string]$_.Enabled;defaultInboundAction=[string]$_.DefaultInboundAction;defaultOutboundAction=[string]$_.DefaultOutboundAction};Assert-Ia4Record $row @('name','enabled','defaultInboundAction','defaultOutboundAction')});",
    "$globalSettings=@(Get-NetFirewallSetting -PolicyStore ActiveStore -ErrorAction Stop|ForEach-Object{$row=[ordered]@{exemptions=(Convert-Ia4CanonicalSettingValue $_.Exemptions);enableStatefulFtp=(Convert-Ia4CanonicalSettingValue $_.EnableStatefulFtp);enableStatefulPptp=(Convert-Ia4CanonicalSettingValue $_.EnableStatefulPptp);requireFullAuthSupport=(Convert-Ia4CanonicalSettingValue $_.RequireFullAuthSupport);certValidationLevel=(Convert-Ia4CanonicalSettingValue $_.CertValidationLevel);allowIpsecThroughNat=(Convert-Ia4CanonicalSettingValue $_.AllowIPsecThroughNAT);maxSaIdleTimeSeconds=(Convert-Ia4CanonicalSettingValue $_.MaxSAIdleTimeSeconds);keyEncoding=(Convert-Ia4CanonicalSettingValue $_.KeyEncoding);enablePacketQueuing=(Convert-Ia4CanonicalSettingValue $_.EnablePacketQueuing)};Assert-Ia4Record $row @('exemptions','enableStatefulFtp','enableStatefulPptp','requireFullAuthSupport','certValidationLevel','allowIpsecThroughNat','maxSaIdleTimeSeconds','keyEncoding','enablePacketQueuing')});",
    "$rules=@(Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop|ForEach-Object{$row=[ordered]@{name=[string]$_.Name;enabled=[string]$_.Enabled;direction=[string]$_.Direction;action=[string]$_.Action;profile=[string]$_.Profile;policyStoreSourceType=[string]$_.PolicyStoreSourceType};Assert-Ia4Record $row @('name','enabled','direction','action','profile','policyStoreSourceType')});",
    "if($profiles.Count -lt 1 -or $globalSettings.Count -ne 1 -or $rules.Count -lt 1){throw 'firewall_nonmutation_component_missing'};",
    "$profileIds=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);foreach($row in $profiles){if(-not$profileIds.Add($row.name)){throw 'firewall_nonmutation_duplicate_identity'}};$ruleIds=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);foreach($row in $rules){if(-not$ruleIds.Add($row.name)){throw 'firewall_nonmutation_duplicate_identity'}};",
    "$profileRows=[string[]]@($profiles|ForEach-Object{ConvertTo-Json -InputObject $_ -Compress -Depth 5});[Array]::Sort($profileRows,[StringComparer]::Ordinal);$ruleRows=[string[]]@($rules|ForEach-Object{ConvertTo-Json -InputObject $_ -Compress -Depth 5});[Array]::Sort($ruleRows,[StringComparer]::Ordinal);$profilesJson='['+[string]::Join(',',$profileRows)+']';$globalJson=ConvertTo-Json -InputObject $globalSettings[0] -Compress -Depth 5;$rulesJson='['+[string]::Join(',',$ruleRows)+']';",
    "$components=@([ordered]@{componentName='profiles';objectCount=[int]$profiles.Count;sha256=(Get-Ia4Hash $profilesJson)},[ordered]@{componentName='globalSettings';objectCount=1;sha256=(Get-Ia4Hash $globalJson)},[ordered]@{componentName='rulesMetadata';objectCount=[int]$rules.Count;sha256=(Get-Ia4Hash $rulesJson)});",
    "$manifest=[ordered]@{contractVersion=1;firewallEvidenceMode='loopback_nonmutation_v1';components=$components};$manifestJson=ConvertTo-Json -InputObject $manifest -Compress -Depth 5;",
    "[ordered]@{contractVersion=1;firewallEvidenceMode='loopback_nonmutation_v1';processElevated=$false;currentUserResolved=($null-ne$identity.User);integrityNonAdministrative=$true;components=$components;aggregateSha256=(Get-Ia4Hash $manifestJson)}|ConvertTo-Json -Compress -Depth 5"
  ].join("");
}

module.exports = {
  COMPONENT_NAMES,
  CONTRACT_VERSION,
  FIREWALL_EVIDENCE_MODE,
  FIREWALL_EVIDENCE_SCOPE,
  FirewallNonmutationFailure,
  GLOBAL_SETTING_FIELDS,
  LOOPBACK_HOST,
  PROFILE_FIELDS,
  RULE_FIELDS,
  assertExecutableFirewallNonmutation,
  buildFirewallLightEvidence,
  canonicalizeFirewallGlobalSettings,
  canonicalizeFirewallProfiles,
  canonicalizeFirewallRules,
  compareFirewallLightEvidence,
  firewallLightEvidencePowerShell,
  proveLoopbackNonmutationExecutablePath,
  validateFirewallLightEvidence,
  validateLoopbackNonmutationContext
};
