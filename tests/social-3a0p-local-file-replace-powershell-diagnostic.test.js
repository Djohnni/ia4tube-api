"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  POWERSHELL_DIAGNOSTIC_FUNCTIONS,
  validateFileReplaceExceptionDiagnostic
} = require("../scripts/social-3a0p-local-file-replace-diagnostic");

test("the exact PowerShell sanitizer walks synthetic exceptions without file I/O", {
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
    POWERSHELL_DIAGNOSTIC_FUNCTIONS,
    "$io=[IO.IOException]::new('SENSITIVE_CANARY');",
    "$outer=[Management.Automation.MethodInvocationException]::new('SENSITIVE_CANARY',$io);",
    "$r1=[Management.Automation.ErrorRecord]::new($outer,'MethodInvocationException',[Management.Automation.ErrorCategory]::InvalidOperation,$null);",
    "$d1=New-IA4FileReplaceDiagnostic $r1;",
    "$fifth=[IO.IOException]::new('SENSITIVE_CANARY');",
    "$fourth=[Exception]::new('SENSITIVE_CANARY',$fifth);",
    "$third=[Exception]::new('SENSITIVE_CANARY',$fourth);",
    "$second=[Exception]::new('SENSITIVE_CANARY',$third);",
    "$first=[Exception]::new('SENSITIVE_CANARY',$second);",
    "$r2=[Management.Automation.ErrorRecord]::new($first,'SyntheticChain',[Management.Automation.ErrorCategory]::NotSpecified,$null);",
    "$d2=New-IA4FileReplaceDiagnostic $r2;",
    "$win=[ComponentModel.Win32Exception]::new(32,'SENSITIVE_CANARY');",
    "$r3=[Management.Automation.ErrorRecord]::new($win,'Win32Synthetic',[Management.Automation.ErrorCategory]::ResourceBusy,$null);",
    "$d3=New-IA4FileReplaceDiagnostic $r3;",
    "@($d1,$d2,$d3)|ConvertTo-Json -Depth 6 -Compress"
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
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /SENSITIVE_CANARY|Message|Stack|Users|SID/i);
  const values = JSON.parse(result.stdout);
  assert.equal(values.length, 3);
  for (const value of values) {
    assert.equal(validateFileReplaceExceptionDiagnostic(value), true);
  }
  assert.equal(values[0].outerExceptionType,
    "System.Management.Automation.MethodInvocationException");
  assert.equal(values[0].innerExceptionType1, "System.IO.IOException");
  assert.equal(values[1].chainTruncated, true);
  assert.equal(values[1].innerExceptionType3, "System.Exception");
  assert.equal(values[2].effectiveExceptionType,
    "System.ComponentModel.Win32Exception");
  assert.equal(values[2].nativeErrorCode, 32);
  assert.equal(values[2].win32Code, 32);
  assert.equal(values[2].win32Symbol, "ERROR_SHARING_VIOLATION");
});
