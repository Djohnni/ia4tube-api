"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  FIREWALL_EVIDENCE_MODE,
  FIREWALL_EVIDENCE_SCOPE,
  PROFILE_FIELDS,
  RULE_FIELDS,
  assertExecutableFirewallNonmutation,
  buildFirewallLightEvidence,
  compareFirewallLightEvidence,
  firewallLightEvidencePowerShell,
  proveLoopbackNonmutationExecutablePath,
  validateFirewallLightEvidence,
  validateLoopbackNonmutationContext
} = require("../scripts/social-3a0p-local-firewall-nonmutation");

function profile(overrides = {}) {
  return {
    name: "Domain",
    enabled: "True",
    defaultInboundAction: "Block",
    defaultOutboundAction: "Allow",
    ...overrides
  };
}

function globalSettings(overrides = {}) {
  return {
    exemptions: "None",
    enableStatefulFtp: "False",
    enableStatefulPptp: "False",
    requireFullAuthSupport: "True",
    certValidationLevel: "RequireCrlCheck",
    allowIpsecThroughNat: "None",
    maxSaIdleTimeSeconds: 300,
    keyEncoding: "UTF8",
    enablePacketQueuing: "None",
    ...overrides
  };
}

function rule(name, overrides = {}) {
  return {
    name,
    enabled: "True",
    direction: "Inbound",
    action: "Block",
    profile: "Any",
    policyStoreSourceType: "Local",
    ...overrides
  };
}

function evidence(overrides = {}) {
  return buildFirewallLightEvidence({
    profiles: [profile({ name: "Private" }), profile({ name: "Domain" })],
    globalSettings: globalSettings(),
    rules: [rule("rule-b"), rule("rule-a")],
    ...overrides
  });
}

test("mode is accepted only for local non-elevated Windows loopback", () => {
  assert.deepEqual(validateLoopbackNonmutationContext({
    mode: FIREWALL_EVIDENCE_MODE,
    platform: "win32",
    scope: FIREWALL_EVIDENCE_SCOPE,
    host: "127.0.0.1",
    processElevated: false
  }), {
    mode: FIREWALL_EVIDENCE_MODE,
    platform: "win32",
    scope: FIREWALL_EVIDENCE_SCOPE,
    host: "127.0.0.1",
    processNonElevated: true
  });
  for (const [field, value, code] of [
    ["platform", "linux", "firewall_nonmutation_platform_refused"],
    ["scope", "staging", "firewall_nonmutation_scope_refused"],
    ["scope", "production", "firewall_nonmutation_scope_refused"],
    ["host", "0.0.0.0", "firewall_nonmutation_host_refused"],
    ["host", "192.168.1.10", "firewall_nonmutation_host_refused"],
    ["processElevated", true, "firewall_nonmutation_elevated_refused"]
  ]) {
    assert.throws(
      () => validateLoopbackNonmutationContext({
        mode: FIREWALL_EVIDENCE_MODE,
        platform: "win32",
        scope: FIREWALL_EVIDENCE_SCOPE,
        host: "127.0.0.1",
        processElevated: false,
        [field]: value
      }),
      { code }
    );
  }
});

test("PowerShell is a three-component ActiveStore batch read without filters or per-rule queries", () => {
  const script = firewallLightEvidencePowerShell();
  assert.equal((script.match(/Get-NetFirewallProfile\b/g) || []).length, 1);
  assert.equal((script.match(/Get-NetFirewallSetting\b/g) || []).length, 1);
  assert.equal((script.match(/Get-NetFirewallRule\b/g) || []).length, 1);
  assert.equal((script.match(/-PolicyStore ActiveStore\b/g) || []).length, 3);
  assert.doesNotMatch(script, /Get-NetFirewall(?:Address|Port|Application|Service|Interface|InterfaceType|Security)Filter/i);
  assert.doesNotMatch(script, /Show-NetFirewallRule/i);
  assert.doesNotMatch(script, /\$[a-z_][a-z0-9_]*\s*\|\s*Get-NetFirewall/i);
  assert.doesNotMatch(script, /DisplayName|Description|DisplayGroup|LogFileName|DisabledInterfaceAliases/);
  assert.deepEqual(PROFILE_FIELDS, [
    "name", "enabled", "defaultInboundAction", "defaultOutboundAction"
  ]);
  assert.deepEqual(RULE_FIELDS, [
    "name", "enabled", "direction", "action", "profile", "policyStoreSourceType"
  ]);
  assert.doesNotMatch(script, /InstanceID/);
  assert.match(script, /processElevated=\$false/);
  assert.match(script, /integrityNonAdministrative=\$true/);
  assert.doesNotMatch(script, /\[uint64\]\$_\.MaxSAIdleTimeSeconds/);
  assert.match(script, /Convert-Ia4CanonicalSettingValue/);
  assert.match(script, /\[Array\]::Sort\(\$ordered,\[StringComparer\]::Ordinal\)/);
  assert.doesNotMatch(script, /exemptions=\[string\]\$_\.Exemptions/);
  assert.match(script, /StringComparer\]::Ordinal/);
});

test("PowerShell sintético canonicaliza ordem e detecta mudanças funcionais", {
  skip: process.platform !== "win32"
}, () => {
  const powershell = path.join(
    process.env.SystemRoot,
    "System32/WindowsPowerShell/v1.0/powershell.exe"
  );
  const run = ({ reverse = false, ruleAction = "Block", profileEnabled = "True" } = {}) => {
    const profiles = reverse
      ? "@($private,$domain)"
      : "@($domain,$private)";
    const rules = reverse
      ? "@($ruleB,$ruleA)"
      : "@($ruleA,$ruleB)";
    const fixtures = [
      `function Get-NetFirewallProfile{[CmdletBinding()]param([string]$PolicyStore);$domain=[pscustomobject]@{Name='Domain';Enabled='${profileEnabled}';DefaultInboundAction='Block';DefaultOutboundAction='Allow'};$private=[pscustomobject]@{Name='Private';Enabled='True';DefaultInboundAction='Block';DefaultOutboundAction='Allow'};${profiles}};`,
      "function Get-NetFirewallSetting{[CmdletBinding()]param([string]$PolicyStore);[pscustomobject]@{Exemptions=@('Teredo','NeighborDiscovery');EnableStatefulFtp='False';EnableStatefulPptp='False';RequireFullAuthSupport='True';CertValidationLevel='None';AllowIPsecThroughNAT='None';MaxSAIdleTimeSeconds=300;KeyEncoding='Utf8';EnablePacketQueuing='None'}};",
      `function Get-NetFirewallRule{[CmdletBinding()]param([string]$PolicyStore);$ruleA=[pscustomobject]@{Name='rule-a';Enabled='True';Direction='Inbound';Action='${ruleAction}';Profile='Domain';PolicyStoreSourceType='Local'};$ruleB=[pscustomobject]@{Name='rule-b';Enabled='False';Direction='Outbound';Action='Allow';Profile='Private';PolicyStoreSourceType='Local'};${rules}};`
    ].join("");
    const result = spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${fixtures}${firewallLightEvidencePowerShell()}`
      ],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  };

  const original = run();
  const expected = buildFirewallLightEvidence({
    profiles: [
      profile({ name: "Domain", enabled: "True" }),
      profile({ name: "Private", enabled: "True" })
    ],
    globalSettings: globalSettings({
      exemptions: Buffer.from(
        JSON.stringify(["NeighborDiscovery", "Teredo"]),
        "utf8"
      ).toString("base64"),
      certValidationLevel: "None",
      maxSaIdleTimeSeconds: "300",
      keyEncoding: "Utf8"
    }),
    rules: [
      rule("rule-a", { action: "Block", profile: "Domain" }),
      rule("rule-b", {
        enabled: "False",
        direction: "Outbound",
        action: "Allow",
        profile: "Private"
      })
    ]
  });
  assert.deepEqual(
    validateFirewallLightEvidence(original),
    expected
  );
  const reordered = run({ reverse: true });
  assert.equal(original.aggregateSha256, reordered.aggregateSha256);
  assert.deepEqual(original.components, reordered.components);

  const changedRule = run({ ruleAction: "Allow" });
  assert.notEqual(
    original.components[2].sha256,
    changedRule.components[2].sha256
  );
  const changedProfile = run({ profileEnabled: "False" });
  assert.notEqual(
    original.components[0].sha256,
    changedProfile.components[0].sha256
  );
});

test("generated executable command passes the nonmutation proof", () => {
  assert.deepEqual(proveLoopbackNonmutationExecutablePath({
    command: firewallLightEvidencePowerShell(),
    sources: [{
      sourceId: "runtime:helper",
      executable: true,
      source: "Get-NetTCPConnection -State Listen"
    }]
  }), {
    firewallMutationCommandsAbsent: true,
    uacElevationCommandsAbsent: true,
    scheduledTaskMutationCommandsAbsent: true,
    serviceMutationCommandsAbsent: true,
    localUserMutationCommandsAbsent: true,
    executableSourcesChecked: 2
  });
});

test("executable firewall mutation forms are refused", () => {
  for (const source of [
    ...["New", "Set", "Remove", "Enable", "Disable", "Rename", "Copy"]
      .map((verb) => `${verb}-NetFirewallRule -Name synthetic`),
    ...["add", "set", "delete", "reset", "import"]
      .map((verb) => `netsh advfirewall firewall ${verb} rule name=synthetic`),
    "Set-CimInstance -InputObject $x # MSFT_NetFirewallRule",
    "Invoke-CimMethod -ClassName MSFT_NetFirewallRule -MethodName Create",
    "New-Object -ComObject HNetCfg.FwPolicy2",
    "policy.Rules.Add(rule)",
    "Set-ItemProperty HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy -Name EnableFirewall -Value 0",
    "reg.exe add HKLM\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy /v EnableFirewall /d 0",
    "Set-GPRegistryValue -Key HKLM\\Software\\Policies\\Microsoft\\WindowsFirewall -ValueName EnableFirewall -Value 0",
    "Start-Process powershell.exe -Verb RunAs",
    "Start-Process powershell.exe -Verb 'RunAs'",
    'Start-Process powershell.exe -Verb "RunAs"',
    "Start-Process powershell.exe `\n  -Verb 'RunAs'",
    "$startInfo = New-Object System.Diagnostics.ProcessStartInfo; $startInfo.Verb = 'runas'; $startInfo.UseShellExecute = $true",
    "(New-Object -ComObject Shell.Application).ShellExecute('powershell.exe', '', '', `\n  'runas', 1)",
    "Start-Process powershell.exe -Credential $credential",
    "powershell.exe -EncodedCommand ZQB4AGkAdAA=",
    "runas.exe /user:Administrator powershell.exe",
    "Register-ScheduledTask -TaskName synthetic",
    "Start-ScheduledTask -TaskName synthetic",
    "Stop-ScheduledTask -TaskName synthetic",
    "schtasks.exe /create /tn synthetic /tr cmd.exe",
    "New-Service -Name synthetic -BinaryPathName cmd.exe",
    "Start-Service -Name synthetic",
    "Stop-Service -Name synthetic",
    "Restart-Service -Name synthetic",
    "sc.exe create synthetic binPath= cmd.exe",
    "sc.exe start synthetic",
    "net.exe stop synthetic",
    "pg_ctl.exe register -N synthetic",
    "New-LocalUser -Name synthetic",
    "net.exe user synthetic changed-password",
    "net.exe localgroup Users synthetic /add"
  ]) {
    assert.throws(
      () => assertExecutableFirewallNonmutation([{
        sourceId: "runtime:synthetic",
        executable: true,
        source
      }]),
      { code: "firewall_nonmutation_mutation_command_refused" }
    );
  }
});

test("the detector implementation cannot create a false executable mutation", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../scripts/social-3a0p-local-firewall-nonmutation.js"),
    "utf8"
  );
  assert.equal(
    assertExecutableFirewallNonmutation([{
      sourceId: "runtime:firewall-nonmutation-detector",
      executable: true,
      source
    }]).firewallMutationCommandsAbsent,
    true
  );
});

test("an isolated non-executable fixture does not create a false positive", () => {
  assert.deepEqual(assertExecutableFirewallNonmutation([
    {
      sourceId: "runtime:read-only",
      executable: true,
      source: "Get-NetFirewallRule -PolicyStore ActiveStore"
    },
    {
      sourceId: "fixture:mutating-negative-case",
      executable: false,
      source: "New-NetFirewallRule -Name never-executed"
    }
  ]), {
    firewallMutationCommandsAbsent: true,
    uacElevationCommandsAbsent: true,
    scheduledTaskMutationCommandsAbsent: true,
    serviceMutationCommandsAbsent: true,
    localUserMutationCommandsAbsent: true,
    executableSourcesChecked: 1
  });
  assert.throws(
    () => assertExecutableFirewallNonmutation([{
      sourceId: "runtime:not-a-fixture",
      executable: false,
      source: "Get-NetFirewallRule"
    }]),
    { code: "firewall_nonmutation_nonexecutable_source_invalid" }
  );
});

test("read-only service and task probes plus taskkill remain allowed", () => {
  assert.deepEqual(assertExecutableFirewallNonmutation([{
    sourceId: "runtime:read-only-context",
    executable: true,
    source: "Get-Service *postgres*; Get-ScheduledTask; taskkill.exe /PID 123 /T /F"
  }]), {
    firewallMutationCommandsAbsent: true,
    uacElevationCommandsAbsent: true,
    scheduledTaskMutationCommandsAbsent: true,
    serviceMutationCommandsAbsent: true,
    localUserMutationCommandsAbsent: true,
    executableSourcesChecked: 1
  });
});

test("canonical ordering makes equivalent profile and rule sets deterministic", () => {
  const first = evidence();
  const second = evidence({
    profiles: [profile({ name: "Domain" }), profile({ name: "Private" })],
    rules: [rule("rule-a"), rule("rule-b")]
  });
  assert.deepEqual(first, second);
  assert.deepEqual(compareFirewallLightEvidence(first, second), {
    equal: true,
    divergentComponent: null,
    fullFirewallFilterSnapshotProved: false,
    firewallProfilesAndRulesMetadataStable: true,
    firewallGlobalSettingsStable: true,
    firewallLightAggregateStable: true
  });
});

test("functional changes identify profiles, global settings, or rulesMetadata", () => {
  const before = evidence();
  const cases = [
    ["profiles", evidence({
      profiles: [
        profile({ name: "Domain", defaultInboundAction: "Allow" }),
        profile({ name: "Private" })
      ]
    })],
    ["globalSettings", evidence({
      globalSettings: globalSettings({ enableStatefulFtp: "True" })
    })],
    ["rulesMetadata", evidence({
      rules: [rule("rule-a"), rule("rule-b", { action: "Allow" })]
    })]
  ];
  for (const [name, after] of cases) {
    const comparison = compareFirewallLightEvidence(before, after);
    assert.equal(comparison.equal, false);
    assert.equal(comparison.divergentComponent, name);
    assert.equal(
      comparison.firewallProfilesAndRulesMetadataStable,
      name === "globalSettings"
    );
    assert.equal(comparison.firewallGlobalSettingsStable, name !== "globalSettings");
    assert.equal(comparison.firewallLightAggregateStable, false);
  }
});

test("missing components and altered aggregate are refused", () => {
  const valid = evidence();
  assert.equal(validateFirewallLightEvidence(valid).aggregateSha256, valid.aggregateSha256);
  assert.throws(
    () => validateFirewallLightEvidence({
      ...valid,
      components: valid.components.slice(0, 2)
    }),
    { code: "firewall_nonmutation_evidence_invalid" }
  );
  assert.throws(
    () => validateFirewallLightEvidence({
      ...valid,
      aggregateSha256: "f".repeat(64)
    }),
    { code: "firewall_nonmutation_aggregate_invalid" }
  );
  assert.throws(
    () => validateFirewallLightEvidence({
      ...valid,
      integrityNonAdministrative: false
    }),
    { code: "firewall_nonmutation_evidence_invalid" }
  );
});

test("unknown, multiline, partial, or duplicate canonical values fail closed", () => {
  assert.throws(
    () => evidence({ profiles: [{ ...profile(), unexpected: true }] }),
    { code: "firewall_nonmutation_profiles_invalid" }
  );
  assert.throws(
    () => evidence({ rules: [rule("same"), rule("SAME")] }),
    { code: "firewall_nonmutation_rules_invalid_duplicate_identity" }
  );
  assert.throws(
    () => evidence({ rules: [rule("rule-a\nunsafe")] }),
    { code: "firewall_nonmutation_rules_invalid" }
  );
  assert.throws(
    () => buildFirewallLightEvidence({
      profiles: [profile()],
      globalSettings: globalSettings(),
      rules: []
    }),
    { code: "firewall_nonmutation_rules_invalid" }
  );
});
