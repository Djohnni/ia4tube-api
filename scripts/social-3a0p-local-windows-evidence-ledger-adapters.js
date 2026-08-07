"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  HarnessFailure
} = require("./social-3a0p-local-harness-core");
const {
  bootstrapStageFailure
} = require("./social-3a0p-local-evidence-bootstrap-diagnostic");
const {
  persistenceStageFailure
} = require("./social-3a0p-local-evidence-persistence-diagnostic");
const {
  POWERSHELL_DIAGNOSTIC_FUNCTIONS,
  systemMetadataFromFileReplaceDiagnostic,
  validateFileReplaceExceptionDiagnostic
} = require("./social-3a0p-local-file-replace-diagnostic");
const {
  POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION,
  validateFileReplaceArgumentDiagnostic
} = require("./social-3a0p-local-file-replace-argument-diagnostic");
const {
  attachTempValidationFailure
} = require("./social-3a0p-local-temp-validation-diagnostic");

const SHA256 = /^[0-9a-f]{64}$/;
const TRANSACTION_ID = /^[0-9a-f]{32}$/;

function fail(code) {
  throw new HarnessFailure(code);
}

function rethrowTempValidationFailure(error, metadata) {
  throw attachTempValidationFailure(error, metadata);
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

function parseAtomicReplaceProof(value) {
  const proof = parseBooleanProof(
    value,
    "windows_evidence_atomic_replace_output_invalid"
  );
  const keys = Object.keys(proof).sort();
  if (proof.ok === true) {
    if (
      keys.length !== 2 ||
      keys[0] !== "argumentDiagnostic" ||
      keys[1] !== "ok"
    ) {
      fail("windows_evidence_atomic_replace_output_invalid");
    }
    validateFileReplaceArgumentDiagnostic(proof.argumentDiagnostic);
    return proof;
  }
  if (
    proof.ok !== false ||
    keys.length !== 3 ||
    keys[0] !== "argumentDiagnostic" ||
    keys[1] !== "exceptionDiagnostic" ||
    keys[2] !== "ok"
  ) {
    fail("windows_evidence_atomic_replace_output_invalid");
  }
  validateFileReplaceArgumentDiagnostic(proof.argumentDiagnostic);
  validateFileReplaceExceptionDiagnostic(proof.exceptionDiagnostic);
  return proof;
}

function validateProtectedAclProof(proof) {
  if (!proof || Object.getPrototypeOf(proof) !== Object.prototype) {
    fail("windows_evidence_acl_proof_invalid");
  }
  const expectedKeys = [
    "ownerCurrentUser",
    "inheritanceProtected",
    "currentUserFullControl",
    "systemFullControl",
    "administratorsFullControl",
    "explicitAllowRuleCount",
    "currentUserAllowRuleCount",
    "systemAllowRuleCount",
    "administratorsAllowRuleCount",
    "inheritedRuleCount",
    "denyRuleCount",
    "unexpectedAllowRuleCount"
  ].sort();
  const keys = Object.keys(proof).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    proof.ownerCurrentUser !== true ||
    proof.inheritanceProtected !== true ||
    proof.currentUserFullControl !== true ||
    proof.systemFullControl !== true ||
    proof.administratorsFullControl !== true ||
    proof.explicitAllowRuleCount !== 3 ||
    proof.currentUserAllowRuleCount !== 1 ||
    proof.systemAllowRuleCount !== 1 ||
    proof.administratorsAllowRuleCount !== 1 ||
    proof.inheritedRuleCount !== 0 ||
    proof.denyRuleCount !== 0 ||
    proof.unexpectedAllowRuleCount !== 0
  ) {
    fail("windows_evidence_acl_refused");
  }
  return true;
}

function validateExplicitBackupArgumentDiagnostic(proof) {
  validateFileReplaceArgumentDiagnostic(proof);
  if (
    proof.backupArgumentBound !== true ||
    proof.backupArgumentIsActualNull !== false ||
    proof.backupArgumentIsEmptyString !== false ||
    proof.backupArgumentIsWhitespace !== false ||
    proof.backupArgumentRuntimeTypeClass !== "string" ||
    proof.backupArgumentLengthClass !== "nonzero" ||
    proof.replaceOverloadArity !== 4 ||
    proof.ignoreMetadataErrors !== true ||
    proof.sourceExists !== true ||
    proof.destinationExists !== true ||
    proof.sourceAndDestinationSameDirectory !== true ||
    proof.sourceAndDestinationSameVolume !== true
  ) {
    fail("windows_evidence_explicit_backup_argument_refused");
  }
  return true;
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
  const replacementTransactions = new Map();
  const replacementAudit = {
    explicitBackupPreparedCount: 0,
    explicitBackupValidatedCount: 0,
    explicitBackupMatchesPreviousRevisionCount: 0,
    newLedgerValidatedCount: 0,
    rollbackAttemptedCount: 0,
    rollbackCompletedCount: 0,
    previousLedgerRestoredCount: 0,
    failedCandidatePreservedCount: 0,
    failedCandidateRemovedAfterRestoreCount: 0,
    backupRemovedAfterValidationCount: 0
  };

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

  async function fileState(target) {
    try {
      const item = await promises.lstat(target);
      if (
        item.isSymbolicLink() ||
        !item.isFile() ||
        item.nlink !== 1
      ) {
        return Object.freeze({ exists: true, safe: false, sha256: null });
      }
      return Object.freeze({
        exists: true,
        safe: true,
        sha256: sha256Bytes(await promises.readFile(target))
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return Object.freeze({ exists: false, safe: true, sha256: null });
      }
      throw error;
    }
  }

  function validateOwnedReplacementPaths({
    temporaryPath,
    targetPath,
    backupPath,
    recoveryPath
  }) {
    let temporary;
    let target;
    let backup;
    let recovery;
    try {
      temporary = absolute(
        temporaryPath,
        "windows_evidence_temporary_target_refused"
      );
      target = absolute(targetPath, "windows_evidence_atomic_target_refused");
      backup = absolute(backupPath, "windows_evidence_backup_target_refused");
      recovery = absolute(
        recoveryPath,
        "windows_evidence_recovery_target_refused"
      );
    } catch (error) {
      rethrowTempValidationFailure(error, {
        tempValidationStage: "second_revision_temp_canonicalize",
        sanitizedFailureClass: "filesystem",
        sanitizedFailureCode: "EINVAL",
        actualConditionClass: "invalid"
      });
    }
    for (const [candidate, code] of [
      [temporary, "windows_evidence_temporary_target_refused"],
      [target, "windows_evidence_atomic_target_refused"],
      [backup, "windows_evidence_backup_target_refused"],
      [recovery, "windows_evidence_recovery_target_refused"]
    ]) {
      if (!isWithin(candidate, evidenceRoot)) {
        try {
          fail(code);
        } catch (error) {
          rethrowTempValidationFailure(error, {
            tempValidationStage: "second_revision_temp_scope_validate",
            sanitizedFailureClass: "harness_validation",
            sanitizedFailureCode: "OUTSIDE_SCOPE",
            actualConditionClass: "outside_scope"
          });
        }
      }
    }
    const temporaryName = path.basename(temporary);
    const targetName = path.basename(target);
    if (
      !temporaryName.startsWith(`.${targetName}.`) ||
      !/^\..+\.[1-9][0-9]*\.[0-9a-f]{16,64}\.tmp$/.test(temporaryName) ||
      path.basename(backup) !== `${temporaryName.slice(0, -4)}.previous.bak` ||
      path.basename(recovery) !== `${temporaryName.slice(0, -4)}.failed.bak` ||
      new Set([temporary, target, backup, recovery].map((item) => item.toLowerCase())).size !== 4
    ) {
      try {
        fail("windows_evidence_replacement_path_contract_refused");
      } catch (error) {
        rethrowTempValidationFailure(error, {
          tempValidationStage:
            "second_revision_temp_ownership_marker_validate",
          sanitizedFailureClass: "ownership",
          sanitizedFailureCode: "MISMATCH",
          actualConditionClass: "mismatch"
        });
      }
    }
    const candidates = [temporary, target, backup, recovery];
    const directories = candidates.map((candidate) =>
      path.dirname(candidate).toLowerCase()
    );
    if (!directories.every((candidate) => candidate === directories[0])) {
      try {
        fail("windows_evidence_replacement_path_contract_refused");
      } catch (error) {
        rethrowTempValidationFailure(error, {
          tempValidationStage: "second_revision_temp_same_directory_validate",
          sanitizedFailureClass: "filesystem",
          sanitizedFailureCode: "MISMATCH",
          actualConditionClass: "different"
        });
      }
    }
    const volumes = candidates.map((candidate) =>
      path.parse(candidate).root.toLowerCase()
    );
    if (!volumes.every((candidate) => candidate === volumes[0])) {
      try {
        fail("windows_evidence_replacement_path_contract_refused");
      } catch (error) {
        rethrowTempValidationFailure(error, {
          tempValidationStage: "second_revision_temp_same_volume_validate",
          sanitizedFailureClass: "filesystem",
          sanitizedFailureCode: "MISMATCH",
          actualConditionClass: "different"
        });
      }
    }
    return Object.freeze({ temporary, target, backup, recovery });
  }

  async function validateProtectedFile(target, expectedSha256, code) {
    await assertPathComponents(target);
    const state = await fileState(target);
    if (
      state.exists !== true ||
      state.safe !== true ||
      !SHA256.test(String(expectedSha256 || "")) ||
      state.sha256 !== expectedSha256
    ) {
      fail(code);
    }
    validateProtectedAclProof(await runAcl("inspect", target));
    return state;
  }

  function safeSystemFailureCode(error) {
    const candidate = String(
      error?.systemErrorCode || error?.code || ""
    ).toUpperCase();
    return [
      "EACCES",
      "EPERM",
      "EBUSY",
      "ENOENT",
      "EEXIST",
      "EINVAL",
      "ENOTEMPTY"
    ].includes(candidate)
      ? candidate
      : "UNKNOWN";
  }

  async function validateReplacementTemporary(target, expectedSha256) {
    let resolved;
    try {
      resolved = requireEvidencePath(
        target,
        "windows_evidence_temporary_target_refused"
      );
    } catch (error) {
      rethrowTempValidationFailure(error, {
        tempValidationStage: "second_revision_temp_canonicalize",
        sanitizedFailureClass: "filesystem",
        sanitizedFailureCode: "EINVAL",
        actualConditionClass: "invalid"
      });
    }

    try {
      await assertPathComponents(resolved);
    } catch (error) {
      const reparseObserved =
        error?.code === "windows_evidence_reparse_refused";
      rethrowTempValidationFailure(error, {
        tempValidationStage: "second_revision_temp_reparse_audit",
        sanitizedFailureClass: "filesystem",
        sanitizedFailureCode: reparseObserved
          ? "REPARSE_DETECTED"
          : safeSystemFailureCode(error),
        actualConditionClass: reparseObserved ? "present" : "unknown"
      });
    }

    let item;
    try {
      item = await promises.lstat(resolved);
    } catch (error) {
      rethrowTempValidationFailure(error, {
        tempValidationStage: "second_revision_temp_exists",
        sanitizedFailureClass: "filesystem",
        sanitizedFailureCode: safeSystemFailureCode(error),
        actualConditionClass:
          String(error?.code || "").toUpperCase() === "ENOENT"
            ? "absent"
            : "unknown"
      });
    }
    if (item.isSymbolicLink()) {
      try {
        fail("windows_evidence_temporary_validation_failed");
      } catch (error) {
        rethrowTempValidationFailure(error, {
          tempValidationStage: "second_revision_temp_reparse_audit",
          sanitizedFailureClass: "filesystem",
          sanitizedFailureCode: "REPARSE_DETECTED",
          actualConditionClass: "present"
        });
      }
    }
    if (!item.isFile()) {
      try {
        fail("windows_evidence_temporary_validation_failed");
      } catch (error) {
        rethrowTempValidationFailure(error, {
          tempValidationStage: "second_revision_temp_regular_file_validate",
          sanitizedFailureClass: "filesystem",
          sanitizedFailureCode: "MISMATCH",
          actualConditionClass: "invalid"
        });
      }
    }
    if (item.nlink !== 1) {
      try {
        fail("windows_evidence_temporary_validation_failed");
      } catch (error) {
        rethrowTempValidationFailure(error, {
          tempValidationStage: "second_revision_temp_hardlink_validate",
          sanitizedFailureClass: "ownership",
          sanitizedFailureCode: "HARDLINK_COUNT_INVALID",
          actualConditionClass: "invalid"
        });
      }
    }

    let bytes;
    try {
      bytes = await promises.readFile(resolved);
    } catch (error) {
      rethrowTempValidationFailure(error, {
        tempValidationStage: "second_revision_temp_hash_validate",
        sanitizedFailureClass: "integrity",
        sanitizedFailureCode: safeSystemFailureCode(error),
        actualConditionClass: "unknown"
      });
    }
    if (
      !SHA256.test(String(expectedSha256 || "")) ||
      sha256Bytes(bytes) !== expectedSha256
    ) {
      try {
        fail("windows_evidence_temporary_validation_failed");
      } catch (error) {
        rethrowTempValidationFailure(error, {
          tempValidationStage: "second_revision_temp_hash_validate",
          sanitizedFailureClass: "integrity",
          sanitizedFailureCode: "HASH_MISMATCH",
          actualConditionClass: "mismatch"
        });
      }
    }

    let proof;
    try {
      proof = await runAcl("inspect", resolved);
    } catch (error) {
      rethrowTempValidationFailure(error, {
        tempValidationStage: "second_revision_temp_acl_validate",
        sanitizedFailureClass: "acl",
        sanitizedFailureCode: safeSystemFailureCode(error),
        actualConditionClass: "unknown"
      });
    }
    if (proof?.ownerCurrentUser !== true) {
      try {
        fail("windows_evidence_acl_refused");
      } catch (error) {
        rethrowTempValidationFailure(error, {
          tempValidationStage: "second_revision_temp_owner_validate",
          sanitizedFailureClass: "ownership",
          sanitizedFailureCode: "OWNER_INVALID",
          actualConditionClass: "invalid"
        });
      }
    }
    try {
      validateProtectedAclProof(proof);
    } catch (error) {
      rethrowTempValidationFailure(error, {
        tempValidationStage: "second_revision_temp_acl_validate",
        sanitizedFailureClass: "acl",
        sanitizedFailureCode: "ACL_INVALID",
        actualConditionClass: "invalid"
      });
    }
    return Object.freeze({ exists: true, safe: true, sha256: expectedSha256 });
  }

  async function requireAbsentArtifact(target, code) {
    await assertPathComponents(target);
    if ((await fileState(target)).exists) fail(code);
    return true;
  }

  async function removeValidatedArtifact(target, expectedSha256, code) {
    await validateProtectedFile(target, expectedSha256, code);
    try {
      await promises.unlink(target);
    } catch (error) {
      if ((await fileState(target)).exists) throw error;
    }
    if ((await fileState(target)).exists) fail(code);
    return true;
  }

  function createTransactionId() {
    let transactionId;
    do {
      transactionId = crypto.randomBytes(16).toString("hex");
    } while (replacementTransactions.has(transactionId));
    return transactionId;
  }

  function requireTransaction(transactionId, allowedStates) {
    if (!TRANSACTION_ID.test(String(transactionId || ""))) {
      fail("windows_evidence_replacement_transaction_refused");
    }
    const transaction = replacementTransactions.get(transactionId);
    if (!transaction || !allowedStates.includes(transaction.state)) {
      fail("windows_evidence_replacement_transaction_refused");
    }
    return transaction;
  }

  async function executeFileReplace({
    source,
    target,
    backup,
    label,
    failureCode
  }) {
    const result = await processRunner.run({
      executable: powershell,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference='Stop';",
          POWERSHELL_DIAGNOSTIC_FUNCTIONS,
          POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION,
          "$backupArgument=[IO.Path]::GetFullPath($env:IA4TUBE_EVIDENCE_BACKUP);",
          "$argumentDiagnostic=New-IA4BackupArgumentDiagnostic $backupArgument $true 4 $true $env:IA4TUBE_EVIDENCE_SOURCE $env:IA4TUBE_EVIDENCE_TARGET;",
          "try{",
          "[IO.File]::Replace($env:IA4TUBE_EVIDENCE_SOURCE,$env:IA4TUBE_EVIDENCE_TARGET,$backupArgument,$true);",
          "[ordered]@{ok=$true;argumentDiagnostic=$argumentDiagnostic}|ConvertTo-Json -Depth 6 -Compress",
          "}catch{",
          "[ordered]@{ok=$false;argumentDiagnostic=$argumentDiagnostic;exceptionDiagnostic=(New-IA4FileReplaceDiagnostic $_)}|ConvertTo-Json -Depth 6 -Compress}"
        ].join("")
      ],
      cwd: cleanupRoot,
      environment: {
        ...environment,
        IA4TUBE_EVIDENCE_SOURCE: source,
        IA4TUBE_EVIDENCE_TARGET: target,
        IA4TUBE_EVIDENCE_BACKUP: backup
      },
      allowedEnvironmentNames: [
        "IA4TUBE_EVIDENCE_SOURCE",
        "IA4TUBE_EVIDENCE_TARGET",
        "IA4TUBE_EVIDENCE_BACKUP"
      ],
      timeoutMs: 15_000,
      label
    });
    const proof = parseAtomicReplaceProof(result.stdoutSanitized);
    validateExplicitBackupArgumentDiagnostic(proof.argumentDiagnostic);
    if (proof.ok !== true) {
      const systemMetadata = systemMetadataFromFileReplaceDiagnostic(
        proof.exceptionDiagnostic
      );
      const safeFailure = new Error("windows_evidence_atomic_replace_failed");
      safeFailure.systemErrorClass = systemMetadata.systemErrorClass;
      safeFailure.systemErrorCode = systemMetadata.systemErrorCode;
      Object.defineProperty(safeFailure, "fileReplaceDiagnostic", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: proof.exceptionDiagnostic
      });
      Object.defineProperty(safeFailure, "fileReplaceArgumentDiagnostic", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: proof.argumentDiagnostic
      });
      throw persistenceStageFailure(
        safeFailure,
        failureCode
      );
    }
    return proof.argumentDiagnostic;
  }

  async function transactionState(transaction) {
    return Object.freeze({
      temporary: await fileState(transaction.temporary),
      target: await fileState(transaction.target),
      backup: await fileState(transaction.backup),
      recovery: await fileState(transaction.recovery)
    });
  }

  return Object.freeze({
    async prepareProtectedDirectory(input) {
      try {
        if (
          path.resolve(input?.controlledRoot || "") !== controlledRoot ||
          path.resolve(input?.evidenceRoot || "") !== evidenceRoot
        ) {
          fail("windows_evidence_prepare_scope_refused");
        }
      } catch (error) {
        throw bootstrapStageFailure(
          error,
          "evidence_root_canonicalization_failed"
        );
      }
      try {
        await assertPathComponents(controlledRoot);
      } catch (error) {
        throw bootstrapStageFailure(error, "evidence_parent_validation_failed");
      }
      try {
        if (fileSystem.existsSync(evidenceRoot)) {
          const exists = new Error("evidence_root_exists");
          exists.code = "EEXIST";
          throw exists;
        }
        const proof = await runAcl("prepare", evidenceRoot);
        if (proof.ok !== true) fail("windows_evidence_acl_prepare_output_invalid");
        return true;
      } catch (error) {
        throw bootstrapStageFailure(error, "evidence_root_create_failed");
      }
    },
    async assertNoReparseComponents(input) {
      const candidates = [
        input?.controlledRoot,
        input?.evidenceRoot,
        input?.cleanupRoot,
        input?.evidencePath,
        input?.temporaryPath,
        input?.backupPath,
        input?.recoveryPath
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
    async writeFileCreateNew(target, bytes) {
      if (!Buffer.isBuffer(bytes)) fail("windows_evidence_bytes_invalid");
      const resolved = requireEvidencePath(
        target,
        "windows_evidence_write_target_refused"
      );
      try {
        return await promises.writeFile(
          resolved,
          bytes,
          { flag: "wx" }
        );
      } catch (error) {
        throw persistenceStageFailure(
          error,
          error?.code === "EEXIST"
            ? "evidence_second_revision_temp_create_failed"
            : "evidence_second_revision_write_failed"
        );
      }
    },
    async flushFile(target) {
      let handle;
      try {
        handle = await promises.open(
          requireEvidencePath(target, "windows_evidence_flush_target_refused"),
          "r+"
        );
      } catch (error) {
        throw persistenceStageFailure(
          error,
          "evidence_second_revision_flush_failed"
        );
      }
      let flushFailure = null;
      try {
        await handle.sync();
      } catch (error) {
        flushFailure = persistenceStageFailure(
          error,
          "evidence_second_revision_flush_failed"
        );
      }
      let closeFailure = null;
      try {
        await handle.close();
      } catch (error) {
        closeFailure = persistenceStageFailure(
          error,
          "evidence_second_revision_close_failed"
        );
      }
      if (flushFailure) throw flushFailure;
      if (closeFailure) throw closeFailure;
      return true;
    },
    async applyProtectedAcl(target) {
      const proof = await runAcl(
        "apply",
        requireEvidencePath(target, "windows_evidence_acl_target_refused")
      );
      return proof.ok === true;
    },
    async prepareFileReplacement({
      temporaryPath,
      targetPath,
      backupPath,
      recoveryPath,
      expectedPreviousSha256,
      expectedReplacementSha256
    }) {
      const paths = validateOwnedReplacementPaths({
        temporaryPath,
        targetPath,
        backupPath,
        recoveryPath
      });
      for (const candidate of Object.values(paths)) {
        await assertPathComponents(candidate);
      }
      await validateReplacementTemporary(
        paths.temporary,
        expectedReplacementSha256
      );
      const targetState = await fileState(paths.target);
      const hadPrevious = expectedPreviousSha256 !== null;
      if (
        hadPrevious
          ? !SHA256.test(String(expectedPreviousSha256 || "")) ||
            targetState.exists !== true ||
            targetState.safe !== true ||
            targetState.sha256 !== expectedPreviousSha256
          : targetState.exists !== false
      ) {
        fail("windows_evidence_previous_revision_mismatch");
      }
      if (hadPrevious) {
        await validateProtectedFile(
          paths.target,
          expectedPreviousSha256,
          "windows_evidence_previous_revision_mismatch"
        );
      }
      await requireAbsentArtifact(
        paths.backup,
        "windows_evidence_backup_preexisting_refused"
      );
      await requireAbsentArtifact(
        paths.recovery,
        "windows_evidence_recovery_preexisting_refused"
      );
      const transactionId = createTransactionId();
      replacementTransactions.set(transactionId, {
        id: transactionId,
        ...paths,
        expectedPreviousSha256,
        expectedReplacementSha256,
        hadPrevious,
        state: "prepared"
      });
      if (hadPrevious) replacementAudit.explicitBackupPreparedCount += 1;
      return Object.freeze({ transactionId, hadPrevious });
    },
    async replaceFileAtomic({ transactionId }) {
      const transaction = requireTransaction(transactionId, ["prepared"]);
      await validateProtectedFile(
        transaction.temporary,
        transaction.expectedReplacementSha256,
        "windows_evidence_temporary_validation_failed"
      );
      if (transaction.hadPrevious) {
        await validateProtectedFile(
          transaction.target,
          transaction.expectedPreviousSha256,
          "windows_evidence_previous_revision_mismatch"
        );
      } else {
        await requireAbsentArtifact(
          transaction.target,
          "windows_evidence_previous_revision_mismatch"
        );
      }
      await requireAbsentArtifact(
        transaction.backup,
        "windows_evidence_backup_preexisting_refused"
      );
      await requireAbsentArtifact(
        transaction.recovery,
        "windows_evidence_recovery_preexisting_refused"
      );
      transaction.state = "commit_attempted";
      if (transaction.hadPrevious) {
        await executeFileReplace({
          source: transaction.temporary,
          target: transaction.target,
          backup: transaction.backup,
          label: "evidence_atomic_replace",
          failureCode: "evidence_second_revision_atomic_replace_failed"
        });
      } else {
        await promises.rename(transaction.temporary, transaction.target);
      }
      transaction.state = "committed_pending_validation";
      await requireAbsentArtifact(
        transaction.temporary,
        "windows_evidence_atomic_replace_unconfirmed"
      );
      await validateProtectedFile(
        transaction.target,
        transaction.expectedReplacementSha256,
        "windows_evidence_atomic_replace_unconfirmed"
      );
      if (transaction.hadPrevious) {
        await validateProtectedFile(
          transaction.backup,
          transaction.expectedPreviousSha256,
          "windows_evidence_backup_validation_failed"
        );
        replacementAudit.explicitBackupValidatedCount += 1;
        replacementAudit.explicitBackupMatchesPreviousRevisionCount += 1;
      } else {
        await requireAbsentArtifact(
          transaction.backup,
          "windows_evidence_atomic_replace_unconfirmed"
        );
      }
      return Object.freeze({ committed: true, previousMatched: true });
    },
    async finalizeFileReplacement({ transactionId }) {
      const transaction = requireTransaction(
        transactionId,
        ["committed_pending_validation"]
      );
      await requireAbsentArtifact(
        transaction.temporary,
        "windows_evidence_replacement_finalize_refused"
      );
      await requireAbsentArtifact(
        transaction.recovery,
        "windows_evidence_replacement_finalize_refused"
      );
      await validateProtectedFile(
        transaction.target,
        transaction.expectedReplacementSha256,
        "windows_evidence_replacement_finalize_refused"
      );
      let previousRevisionBackupRemoved = false;
      if (transaction.hadPrevious) {
        try {
          await removeValidatedArtifact(
            transaction.backup,
            transaction.expectedPreviousSha256,
            "windows_evidence_replacement_finalize_refused"
          );
        } catch (error) {
          const reconciled = await transactionState(transaction);
          const removalCompleted =
            !reconciled.temporary.exists &&
            reconciled.target.exists &&
            reconciled.target.safe &&
            reconciled.target.sha256 === transaction.expectedReplacementSha256 &&
            !reconciled.backup.exists &&
            !reconciled.recovery.exists;
          if (!removalCompleted) throw error;
        }
        previousRevisionBackupRemoved = true;
        replacementAudit.backupRemovedAfterValidationCount += 1;
      } else {
        await requireAbsentArtifact(
          transaction.backup,
          "windows_evidence_replacement_finalize_refused"
        );
      }
      transaction.state = "finalized";
      replacementTransactions.delete(transactionId);
      replacementAudit.newLedgerValidatedCount += 1;
      return Object.freeze({
        finalized: true,
        previousRevisionBackupRemoved
      });
    },
    async rollbackFileReplacement({ transactionId }) {
      const transaction = requireTransaction(transactionId, [
        "prepared",
        "commit_attempted",
        "committed_pending_validation"
      ]);
      replacementAudit.rollbackAttemptedCount += 1;
      let failedCandidatePreserved = false;
      try {
        let state = await transactionState(transaction);
        if (
          state.temporary.exists &&
          (!state.temporary.safe ||
            state.temporary.sha256 !== transaction.expectedReplacementSha256)
        ) {
          fail("windows_evidence_replacement_state_ambiguous");
        }
        if (transaction.hadPrevious) {
          const unchanged =
            state.target.exists && state.target.safe &&
            state.target.sha256 === transaction.expectedPreviousSha256 &&
            !state.backup.exists && !state.recovery.exists;
          const duplicateBackup =
            state.target.exists && state.target.safe &&
            state.target.sha256 === transaction.expectedPreviousSha256 &&
            state.backup.exists && state.backup.safe &&
            state.backup.sha256 === transaction.expectedPreviousSha256 &&
            !state.recovery.exists;
          const promoted =
            !state.temporary.exists &&
            state.target.exists && state.target.safe &&
            state.target.sha256 === transaction.expectedReplacementSha256 &&
            state.backup.exists && state.backup.safe &&
            state.backup.sha256 === transaction.expectedPreviousSha256 &&
            !state.recovery.exists;
          const restoredPendingCleanup =
            !state.backup.exists &&
            state.target.exists && state.target.safe &&
            state.target.sha256 === transaction.expectedPreviousSha256 &&
            state.recovery.exists && state.recovery.safe &&
            state.recovery.sha256 === transaction.expectedReplacementSha256;
          if (duplicateBackup) {
            await removeValidatedArtifact(
              transaction.backup,
              transaction.expectedPreviousSha256,
              "windows_evidence_replacement_rollback_refused"
            );
            state = await transactionState(transaction);
          } else if (promoted) {
            await validateProtectedFile(
              transaction.target,
              transaction.expectedReplacementSha256,
              "windows_evidence_replacement_rollback_refused"
            );
            await validateProtectedFile(
              transaction.backup,
              transaction.expectedPreviousSha256,
              "windows_evidence_replacement_rollback_refused"
            );
            try {
              await executeFileReplace({
                source: transaction.backup,
                target: transaction.target,
                backup: transaction.recovery,
                label: "evidence_atomic_rollback",
                failureCode: "evidence_second_revision_rollback_failed"
              });
            } catch (replaceError) {
              state = await transactionState(transaction);
              const physicallyRestored =
                !state.backup.exists &&
                state.target.exists && state.target.safe &&
                state.target.sha256 === transaction.expectedPreviousSha256 &&
                state.recovery.exists && state.recovery.safe &&
                state.recovery.sha256 === transaction.expectedReplacementSha256;
              if (!physicallyRestored) throw replaceError;
            }
            state = await transactionState(transaction);
          } else if (!unchanged && !restoredPendingCleanup) {
            fail("windows_evidence_replacement_state_ambiguous");
          }
          await validateProtectedFile(
            transaction.target,
            transaction.expectedPreviousSha256,
            "windows_evidence_replacement_rollback_refused"
          );
          state = await transactionState(transaction);
          if (state.recovery.exists) {
            await removeValidatedArtifact(
              transaction.recovery,
              transaction.expectedReplacementSha256,
              "windows_evidence_replacement_rollback_refused"
            );
            failedCandidatePreserved = true;
          }
          if ((await fileState(transaction.backup)).exists) {
            fail("windows_evidence_replacement_rollback_refused");
          }
        } else {
          if (state.backup.exists || state.recovery.exists) {
            fail("windows_evidence_replacement_state_ambiguous");
          }
          if (state.target.exists) {
            if (
              !state.target.safe ||
              state.target.sha256 !== transaction.expectedReplacementSha256
            ) {
              fail("windows_evidence_replacement_state_ambiguous");
            }
            await removeValidatedArtifact(
              transaction.target,
              transaction.expectedReplacementSha256,
              "windows_evidence_replacement_rollback_refused"
            );
            failedCandidatePreserved = true;
          }
        }
        transaction.state = "rolled_back";
        replacementTransactions.delete(transactionId);
        replacementAudit.rollbackCompletedCount += 1;
        replacementAudit.previousLedgerRestoredCount += 1;
        if (failedCandidatePreserved) {
          replacementAudit.failedCandidatePreservedCount += 1;
          replacementAudit.failedCandidateRemovedAfterRestoreCount += 1;
        }
        return Object.freeze({
          rollbackCompleted: true,
          previousLedgerRestored: true,
          failedCandidatePreserved,
          failedCandidateRemovedAfterRestore: failedCandidatePreserved
        });
      } catch (error) {
        transaction.state = "recovery_required";
        throw error;
      }
    },
    async removeOwnedTemporaryFile({ temporaryPath, evidenceRoot: expectedRoot }) {
      const temporary = requireEvidencePath(
        temporaryPath,
        "windows_evidence_temporary_target_refused"
      );
      if (
        path.resolve(expectedRoot || "") !== evidenceRoot ||
        !/^\..+\.[1-9][0-9]*\.[0-9a-f]{16,64}\.tmp$/.test(
          path.basename(temporary)
        )
      ) {
        fail("windows_evidence_temporary_remove_refused");
      }
      await assertPathComponents(temporary);
      validateProtectedAclProof(await runAcl("inspect", evidenceRoot));
      const temporaryState = await fileState(temporary);
      if (!temporaryState.exists || !temporaryState.safe) {
        fail("windows_evidence_temporary_remove_refused");
      }
      await promises.unlink(temporary);
      return !(await fileState(temporary)).exists;
    },
    getReplacementAudit() {
      return Object.freeze({
        ...replacementAudit,
        openTransactionCount: replacementTransactions.size
      });
    },
    async cleanupFailedInitialization(input) {
      if (
        path.resolve(input?.controlledRoot || "") !== controlledRoot ||
        path.resolve(input?.evidenceRoot || "") !== evidenceRoot ||
        path.resolve(input?.cleanupRoot || "") !== cleanupRoot
      ) {
        fail("windows_evidence_initialization_cleanup_scope_refused");
      }
      if (!fileSystem.existsSync(evidenceRoot)) return true;
      try {
        await assertPathComponents(evidenceRoot);
        const proof = await runAcl("inspect", evidenceRoot);
        if (
          proof.ownerCurrentUser !== true ||
          proof.inheritanceProtected !== true ||
          proof.explicitAllowRuleCount !== 3 ||
          proof.inheritedRuleCount !== 0 ||
          proof.denyRuleCount !== 0 ||
          proof.unexpectedAllowRuleCount !== 0
        ) {
          fail("windows_evidence_initialization_cleanup_acl_refused");
        }
        const entries = await promises.readdir(evidenceRoot);
        if (entries.length !== 0) {
          fail("windows_evidence_initialization_cleanup_nonempty_refused");
        }
        await promises.rmdir(evidenceRoot);
        return !fileSystem.existsSync(evidenceRoot);
      } catch (error) {
        throw bootstrapStageFailure(
          error,
          "evidence_ledger_partial_cleanup_failed"
        );
      }
    }
  });
}

module.exports = {
  createWindowsEvidenceLedgerAdapters
};
