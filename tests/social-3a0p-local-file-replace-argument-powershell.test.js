"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION,
  validateFileReplaceArgumentDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-argument-diagnostic");

test("the exact PowerShell helper observes null before binding and typed empty string distinctly", {
  skip: process.platform !== "win32"
}, () => {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const system32 = path.join(systemRoot, "System32");
  const powershell = path.join(
    system32,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const script = [
    "$ErrorActionPreference='Stop';",
    POWERSHELL_ARGUMENT_DIAGNOSTIC_FUNCTION,
    "$source=[IO.Path]::Combine($env:TEMP,'ia4-source.synthetic');",
    "$destination=[IO.Path]::Combine($env:TEMP,'ia4-destination.synthetic');",
    "$untyped=$null;",
    "$d1=New-IA4BackupArgumentDiagnostic $untyped $true 4 $true $source $destination;",
    "[string]$typed=$null;",
    "$d2=New-IA4BackupArgumentDiagnostic $typed $true 4 $true $source $destination;",
    "$arguments=[object[]]@($source,$destination,$null,$true);",
    "$d3=New-IA4BackupArgumentDiagnostic $arguments[2] $true $arguments.Length $arguments[3] $arguments[0] $arguments[1];",
    "$shape=[ordered]@{argumentCountFour=($arguments.Length-eq4);sourceAndDestinationStrings=(($arguments[0]-is[string])-and($arguments[1]-is[string]));thirdSlotActualNull=($null-eq$arguments[2]);fourthSlotBoolean=($arguments[3]-is[bool])};",
    "[ordered]@{untyped=$d1;typed=$d2;reflection=$d3;reflectionShape=$shape}|ConvertTo-Json -Depth 5 -Compress"
  ].join("");
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      cwd: system32,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      env: {
        ComSpec: path.join(system32, "cmd.exe"),
        PATH: [system32, path.dirname(powershell)].join(path.delimiter),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemDrive: path.parse(systemRoot).root.replace(/[\\/]$/, ""),
        SystemRoot: systemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        WINDIR: systemRoot
      }
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /Users|source\.synthetic|destination\.synthetic/i);
  const values = JSON.parse(result.stdout);
  for (const key of ["untyped", "typed", "reflection"]) {
    assert.equal(validateFileReplaceArgumentDiagnostic(values[key]), true);
  }
  assert.equal(values.untyped.backupArgumentIsActualNull, true);
  assert.equal(values.typed.backupArgumentIsEmptyString, true);
  assert.equal(values.reflection.backupArgumentIsActualNull, true);
  assert.deepEqual(values.reflectionShape, {
    argumentCountFour: true,
    sourceAndDestinationStrings: true,
    thirdSlotActualNull: true,
    fourthSlotBoolean: true
  });
});
