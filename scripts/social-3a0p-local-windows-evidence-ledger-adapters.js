"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  HarnessFailure
} = require("./social-3a0p-local-harness-core");

const SHA256 = /^[0-9a-f]{64}$/;

function fail(code) {
  throw new HarnessFailure(code);
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function absolute(value, code) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    /^(?:\\\\\?\\|\\\\\.\\)/.test(value)
  ) {
    fail(code);
  }
  return path.resolve(value);
}

function parseBooleanProof(value, code) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || "").trim());
  } catch {
    fail(code);
  }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype) fail(code);
  return parsed;
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createWindowsEvidenceLedgerAdapters(options = {}) {
  const controlledRoot = absolute(
    options.controlledRoot,
    "windows_evidence_controlled_root_invalid"
  );
  const evidenceRoot = absolute(
    options.evidenceRoot,
    "windows_evidence_root_invalid"
  );
  const cleanupRoot = absolute(
    options.cleanupRoot,
    "windows_evidence_cleanup_root_invalid"
  );
  const powershell = absolute(
    options.powershell,
    "windows_evidence_powershell_invalid"
  );
  const processRunner = options.processRunner;
  const environment = options.environment;
  const fileSystem = options.fileSystem || fs;
  const promises = fileSystem.promises;
  if (
    typeof processRunner?.run !== "function" ||
    !environment ||
    Object.getPrototypeOf(environment) !== Object.prototype ||
    !isWithin(evidenceRoot, controlledRoot) ||
    !isWithin(cleanupRoot, controlledRoot) ||
    isWithin(evidenceRoot, cleanupRoot) ||
    isWithin(cleanupRoot, evidenceRoot)
  ) {
    fail("windows_evidence_adapter_configuration_invalid");
  }

  function requireEvidencePath(candidate, code) {
    const resolved = absolute(candidate, code);
    if (!isWithin(resolved, evidenceRoot)) fail(code);
    return resolved;
  }

  async function runAcl(mode, target) {
    const scripts = {
      prepare: [
        "$ErrorActionPreference='Stop';$p=[IO.Path]::GetFullPath($env:IA4TUBE_EVIDENCE_TARGET);",
        "if(Test-Path -LiteralPath $p){throw 'target_exists'};",
        "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;",
        "$s=New-Object Security.AccessControl.DirectorySecurity;",
        "$s.SetAccessRuleProtection($true,$false);$s.SetOwner($me);",
        "$f=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';",
        "foreach($v in @($me.Value,'S-1-5-18','S-1-5-32-544')){",
        "$sid=New-Object Security.Principal.SecurityIdentifier($v);",
        "$r=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$f,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);",
        "[void]$s.AddAccessRule($r)};",
        "[void][IO.Directory]::CreateDirectory($p,$s);@{ok=$true}|ConvertTo-Json -Compress"
      ].join(""),
      apply: [
        "$ErrorActionPreference='Stop';$p=[IO.Path]::GetFullPath($env:IA4TUBE_EVIDENCE_TARGET);",
        "$i=Get-Item -LiteralPath $p -Force;$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;",
        "if($i.PSIsContainer){$s=New-Object Security.AccessControl.DirectorySecurity;$f=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}",
        "else{$s=New-Object Security.AccessControl.FileSecurity;$f=[Security.AccessControl.InheritanceFlags]::None};",
        "$s.SetAccessRuleProtection($true,$false);$s.SetOwner($me);",
        "foreach($v in @($me.Value,'S-1-5-18','S-1-5-32-544')){",
        "$sid=New-Object Security.Principal.SecurityIdentifier($v);",
        "$r=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$f,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);",
        "[void]$s.AddAccessRule($r)};$i.SetAccessControl($s);@{ok=$true}|ConvertTo-Json -Compress"
      ].join(""),
      inspect: [
        "$ErrorActionPreference='Stop';$p=[IO.Path]::GetFullPath($env:IA4TUBE_EVIDENCE_TARGET);",
        "$a=Get-Acl -LiteralPath $p;$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;",
        "$system='S-1-5-18';$admins='S-1-5-32-544';$allowed=@($me,$system,$admins);$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));",
        "$owner=([Security.Principal.NTAccount]$a.Owner).Translate([Security.Principal.SecurityIdentifier]).Value;",
        "$allows=@($rules|Where-Object{$_.AccessControlType-eq'Allow'});$current=@($allows|Where-Object{$_.IdentityReference.Value-eq$me});$systemRules=@($allows|Where-Object{$_.IdentityReference.Value-eq$system});$adminRules=@($allows|Where-Object{$_.IdentityReference.Value-eq$admins});",
        "$currentFull=@($current|Where-Object{($_.FileSystemRights-band[Security.AccessControl.FileSystemRights]::FullControl)-eq[Security.AccessControl.FileSystemRights]::FullControl}).Count-eq1;",
        "$systemFull=@($systemRules|Where-Object{($_.FileSystemRights-band[Security.AccessControl.FileSystemRights]::FullControl)-eq[Security.AccessControl.FileSystemRights]::FullControl}).Count-eq1;",
        "$adminFull=@($adminRules|Where-Object{($_.FileSystemRights-band[Security.AccessControl.FileSystemRights]::FullControl)-eq[Security.AccessControl.FileSystemRights]::FullControl}).Count-eq1;",
        "$unexpected=@($allows|Where-Object{$_.IdentityReference.Value-notin$allowed}).Count;",
        "@{ownerCurrentUser=($owner-eq$me);inheritanceProtected=[bool]$a.AreAccessRulesProtected;currentUserFullControl=$currentFull;systemFullControl=$systemFull;administratorsFullControl=$adminFull;explicitAllowRuleCount=@($allows|Where-Object{-not $_.IsInherited}).Count;currentUserAllowRuleCount=$current.Count;systemAllowRuleCount=$systemRules.Count;administratorsAllowRuleCount=$adminRules.Count;inheritedRuleCount=@($rules|Where-Object{$_.IsInherited}).Count;denyRuleCount=@($rules|Where-Object{$_.AccessControlType-eq'Deny'}).Count;unexpectedAllowRuleCount=$unexpected}|ConvertTo-Json -Compress"
      ].join("")
    };
    const script = scripts[mode];
    if (!script) fail("windows_evidence_acl_mode_invalid");
    const result = await processRunner.run({
      executable: powershell,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script
      ],
      cwd: cleanupRoot,
      environment: {
        ...environment,
        IA4TUBE_EVIDENCE_TARGET: target
      },
      allowedEnvironmentNames: ["IA4TUBE_EVIDENCE_TARGET"],
      timeoutMs: 15_000,
      label: `evidence_acl_${mode}`
    });
    return parseBooleanProof(
      result.stdoutSanitized,
      `windows_evidence_acl_${mode}_output_invalid`
    );
  }

  async function runReparseAudit(target) {
    const result = await processRunner.run({
      executable: powershell,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference='Stop';$p=[IO.Path]::GetFullPath($env:IA4TUBE_EVIDENCE_TARGET);",
          "$root=[IO.Path]::GetPathRoot($p);$current=$root;$found=$false;",
          "$relative=$p.Substring($root.Length);",
          "foreach($part in @($relative.Split([IO.Path]::DirectorySeparatorChar,[StringSplitOptions]::RemoveEmptyEntries))){",
          "$current=[IO.Path]::Combine($current,$part);",
          "if(-not(Test-Path -LiteralPath $current)){break};",
          "$item=Get-Item -LiteralPath $current -Force;",
          "if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){$found=$true;break}};",
          "@{ok=(-not $found);reparsePointDetected=$found}|ConvertTo-Json -Compress"
        ].join("")
      ],
      cwd: cleanupRoot,
      environment: {
        ...environment,
        IA4TUBE_EVIDENCE_TARGET: target
      },
      allowedEnvironmentNames: ["IA4TUBE_EVIDENCE_TARGET"],
      timeoutMs: 15_000,
      label: "evidence_reparse_audit"
    });
    const proof = parseBooleanProof(
      result.stdoutSanitized,
      "windows_evidence_reparse_output_invalid"
    );
    const keys = Object.keys(proof).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "ok" ||
      keys[1] !== "reparsePointDetected" ||
      proof.ok !== true ||
      proof.reparsePointDetected !== false
    ) {
      fail("windows_evidence_reparse_refused");
    }
    return true;
  }

  async function assertPathComponents(target) {
    const resolved = absolute(target, "windows_evidence_path_invalid");
    if (!isWithin(resolved, controlledRoot)) {
      fail("windows_evidence_path_scope_refused");
    }
    const relative = path.relative(controlledRoot, resolved);
    const components = relative ? relative.split(path.sep) : [];
    let current = controlledRoot;
    try {
      const rootItem = await promises.lstat(current);
      if (rootItem.isSymbolicLink()) fail("windows_evidence_reparse_refused");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      fail("windows_evidence_controlled_root_missing");
    }
    for (const component of components) {
      current = path.join(current, component);
      let item;
      try {
        item = await promises.lstat(current);
      } catch (error) {
        if (error?.code === "ENOENT") break;
        throw error;
      }
      if (item.isSymbolicLink()) fail("windows_evidence_reparse_refused");
    }
    await runReparseAudit(resolved);
    return true;
  }

  return Object.freeze({
    async prepareProtectedDirectory(input) {
      if (
        path.resolve(input?.controlledRoot || "") !== controlledRoot ||
        path.resolve(input?.evidenceRoot || "") !== evidenceRoot
      ) {
        fail("windows_evidence_prepare_scope_refused");
      }
      await assertPathComponents(controlledRoot);
      if (fileSystem.existsSync(evidenceRoot)) {
        fail("windows_evidence_root_exists");
      }
      const proof = await runAcl("prepare", evidenceRoot);
      return proof.ok === true;
    },
    async assertNoReparseComponents(input) {
      const candidates = [
        input?.controlledRoot,
        input?.evidenceRoot,
        input?.cleanupRoot,
        input?.evidencePath,
        input?.temporaryPath
      ].filter(Boolean);
      for (const candidate of candidates) await assertPathComponents(candidate);
      return true;
    },
    inspectProtectedAcl(target) {
      return runAcl("inspect", requireEvidencePath(target, "windows_evidence_acl_target_refused"));
    },
    async exists(target) {
      const resolved = requireEvidencePath(target, "windows_evidence_exists_target_refused");
      try {
        await promises.access(resolved);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
    readFile(target) {
      return promises.readFile(requireEvidencePath(target, "windows_evidence_read_target_refused"));
    },
    writeFileCreateNew(target, bytes) {
      if (!Buffer.isBuffer(bytes)) fail("windows_evidence_bytes_invalid");
      return promises.writeFile(
        requireEvidencePath(target, "windows_evidence_write_target_refused"),
        bytes,
        { flag: "wx" }
      );
    },
    async flushFile(target) {
      const handle = await promises.open(
        requireEvidencePath(target, "windows_evidence_flush_target_refused"),
        "r+"
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    },
    async applyProtectedAcl(target) {
      const proof = await runAcl(
        "apply",
        requireEvidencePath(target, "windows_evidence_acl_target_refused")
      );
      return proof.ok === true;
    },
    async replaceFileAtomic({ temporaryPath, targetPath, expectedPreviousSha256 }) {
      const temporary = requireEvidencePath(
        temporaryPath,
        "windows_evidence_temporary_target_refused"
      );
      const target = requireEvidencePath(
        targetPath,
        "windows_evidence_atomic_target_refused"
      );
      let previousMatched = false;
      const targetExists = fileSystem.existsSync(target);
      if (expectedPreviousSha256 === null) {
        previousMatched = !targetExists;
      } else if (SHA256.test(String(expectedPreviousSha256 || "")) && targetExists) {
        previousMatched = sha256Bytes(await promises.readFile(target)) === expectedPreviousSha256;
      }
      if (!previousMatched) fail("windows_evidence_previous_revision_mismatch");
      const temporarySha256 = sha256Bytes(await promises.readFile(temporary));
      if (!targetExists) {
        await promises.rename(temporary, target);
      } else {
        const result = await processRunner.run({
          executable: powershell,
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            [
              "$ErrorActionPreference='Stop';",
              "[IO.File]::Replace($env:IA4TUBE_EVIDENCE_TEMP,$env:IA4TUBE_EVIDENCE_TARGET,$null,$true);",
              "@{ok=$true}|ConvertTo-Json -Compress"
            ].join("")
          ],
          cwd: cleanupRoot,
          environment: {
            ...environment,
            IA4TUBE_EVIDENCE_TEMP: temporary,
            IA4TUBE_EVIDENCE_TARGET: target
          },
          allowedEnvironmentNames: [
            "IA4TUBE_EVIDENCE_TEMP",
            "IA4TUBE_EVIDENCE_TARGET"
          ],
          timeoutMs: 15_000,
          label: "evidence_atomic_replace"
        });
        const proof = parseBooleanProof(
          result.stdoutSanitized,
          "windows_evidence_atomic_replace_output_invalid"
        );
        if (proof.ok !== true) fail("windows_evidence_atomic_replace_failed");
      }
      if (
        fileSystem.existsSync(temporary) ||
        !fileSystem.existsSync(target) ||
        sha256Bytes(await promises.readFile(target)) !== temporarySha256
      ) {
        fail("windows_evidence_atomic_replace_unconfirmed");
      }
      return Object.freeze({ committed: true, previousMatched: true });
    },
    async removeOwnedTemporaryFile({ temporaryPath, evidenceRoot: expectedRoot }) {
      const temporary = requireEvidencePath(
        temporaryPath,
        "windows_evidence_temporary_target_refused"
      );
      if (
        path.resolve(expectedRoot || "") !== evidenceRoot ||
        !path.basename(temporary).startsWith(".") ||
        !path.basename(temporary).endsWith(".tmp")
      ) {
        fail("windows_evidence_temporary_remove_refused");
      }
      await promises.unlink(temporary);
      return true;
    }
  });
}

module.exports = {
  createWindowsEvidenceLedgerAdapters
};
