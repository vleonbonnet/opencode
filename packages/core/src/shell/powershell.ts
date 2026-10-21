export * as ShellPowerShell from "./powershell.js"

// The cmdlets Windows PowerShell 5.1 runs for its built-in aliases, by the alias in lower case.
const ALIASES: Record<string, string> = {
  "%": "ForEach-Object",
  "?": "Where-Object",
  ac: "Add-Content",
  asnp: "Add-PSSnapIn",
  cat: "Get-Content",
  cd: "Set-Location",
  cfs: "ConvertFrom-String",
  chdir: "Set-Location",
  clc: "Clear-Content",
  clear: "Clear-Host",
  clhy: "Clear-History",
  cli: "Clear-Item",
  clp: "Clear-ItemProperty",
  cls: "Clear-Host",
  clv: "Clear-Variable",
  cnsn: "Connect-PSSession",
  compare: "Compare-Object",
  copy: "Copy-Item",
  cp: "Copy-Item",
  cpi: "Copy-Item",
  cpp: "Copy-ItemProperty",
  curl: "Invoke-WebRequest",
  cvpa: "Convert-Path",
  dbp: "Disable-PSBreakpoint",
  del: "Remove-Item",
  diff: "Compare-Object",
  dir: "Get-ChildItem",
  dnsn: "Disconnect-PSSession",
  ebp: "Enable-PSBreakpoint",
  echo: "Write-Output",
  epal: "Export-Alias",
  epcsv: "Export-Csv",
  epsn: "Export-PSSession",
  erase: "Remove-Item",
  etsn: "Enter-PSSession",
  exsn: "Exit-PSSession",
  fc: "Format-Custom",
  fhx: "Format-Hex",
  fl: "Format-List",
  foreach: "ForEach-Object",
  ft: "Format-Table",
  fw: "Format-Wide",
  gal: "Get-Alias",
  gbp: "Get-PSBreakpoint",
  gc: "Get-Content",
  gci: "Get-ChildItem",
  gcm: "Get-Command",
  gcs: "Get-PSCallStack",
  gdr: "Get-PSDrive",
  ghy: "Get-History",
  gi: "Get-Item",
  gjb: "Get-Job",
  gl: "Get-Location",
  gm: "Get-Member",
  gmo: "Get-Module",
  gp: "Get-ItemProperty",
  gps: "Get-Process",
  gpv: "Get-ItemPropertyValue",
  group: "Group-Object",
  gsn: "Get-PSSession",
  gsnp: "Get-PSSnapIn",
  gsv: "Get-Service",
  gu: "Get-Unique",
  gv: "Get-Variable",
  gwmi: "Get-WmiObject",
  h: "Get-History",
  history: "Get-History",
  icm: "Invoke-Command",
  iex: "Invoke-Expression",
  ihy: "Invoke-History",
  ii: "Invoke-Item",
  ipal: "Import-Alias",
  ipcsv: "Import-Csv",
  ipmo: "Import-Module",
  ipsn: "Import-PSSession",
  irm: "Invoke-RestMethod",
  iwmi: "Invoke-WMIMethod",
  iwr: "Invoke-WebRequest",
  kill: "Stop-Process",
  lp: "Out-Printer",
  ls: "Get-ChildItem",
  measure: "Measure-Object",
  mi: "Move-Item",
  mount: "New-PSDrive",
  move: "Move-Item",
  mp: "Move-ItemProperty",
  mv: "Move-Item",
  nal: "New-Alias",
  ndr: "New-PSDrive",
  ni: "New-Item",
  nmo: "New-Module",
  npssc: "New-PSSessionConfigurationFile",
  nsn: "New-PSSession",
  nv: "New-Variable",
  ogv: "Out-GridView",
  oh: "Out-Host",
  popd: "Pop-Location",
  ps: "Get-Process",
  pushd: "Push-Location",
  pwd: "Get-Location",
  r: "Invoke-History",
  rbp: "Remove-PSBreakpoint",
  rcjb: "Receive-Job",
  rcsn: "Receive-PSSession",
  rd: "Remove-Item",
  rdr: "Remove-PSDrive",
  ren: "Rename-Item",
  ri: "Remove-Item",
  rjb: "Remove-Job",
  rm: "Remove-Item",
  rmdir: "Remove-Item",
  rmo: "Remove-Module",
  rni: "Rename-Item",
  rnp: "Rename-ItemProperty",
  rp: "Remove-ItemProperty",
  rsn: "Remove-PSSession",
  rsnp: "Remove-PSSnapin",
  rujb: "Resume-Job",
  rv: "Remove-Variable",
  rvpa: "Resolve-Path",
  rwmi: "Remove-WMIObject",
  sajb: "Start-Job",
  sal: "Set-Alias",
  saps: "Start-Process",
  sasv: "Start-Service",
  sbp: "Set-PSBreakpoint",
  sc: "Set-Content",
  select: "Select-Object",
  set: "Set-Variable",
  shcm: "Show-Command",
  si: "Set-Item",
  sl: "Set-Location",
  sleep: "Start-Sleep",
  sls: "Select-String",
  sort: "Sort-Object",
  sp: "Set-ItemProperty",
  spjb: "Stop-Job",
  spps: "Stop-Process",
  spsv: "Stop-Service",
  start: "Start-Process",
  sujb: "Suspend-Job",
  sv: "Set-Variable",
  swmi: "Set-WMIInstance",
  tee: "Tee-Object",
  trcm: "Trace-Command",
  type: "Get-Content",
  wget: "Invoke-WebRequest",
  where: "Where-Object",
  wjb: "Wait-Job",
  write: "Write-Output",
}

// Each cmdlet above by its name in lower case, so a cmdlet written in another case is spelled as it is declared.
const CMDLETS = new Map(Object.values(ALIASES).map((name) => [name.toLowerCase(), name]))

type Parameter = { name: string; switch?: true; aliases?: readonly string[] }

// The parameters every cmdlet takes, in Windows PowerShell 5.1 and PowerShell 7.
const COMMON: readonly Parameter[] = [
  { name: "Debug", switch: true, aliases: ["db"] },
  { name: "ErrorAction", aliases: ["ea"] },
  { name: "ErrorVariable", aliases: ["ev"] },
  { name: "InformationAction", aliases: ["infa"] },
  { name: "InformationVariable", aliases: ["iv"] },
  { name: "OutBuffer", aliases: ["ob"] },
  { name: "OutVariable", aliases: ["ov"] },
  { name: "PipelineVariable", aliases: ["pv"] },
  { name: "ProgressAction", aliases: ["proga"] },
  { name: "Verbose", switch: true, aliases: ["vb"] },
  { name: "WarningAction", aliases: ["wa"] },
  { name: "WarningVariable", aliases: ["wv"] },
]

// Every parameter of the cmdlets whose parameters rules name, in either PowerShell, so an abbreviation resolves as
// PowerShell resolves it: to the one parameter whose name or alias it begins.
const PARAMETERS: Record<string, readonly Parameter[]> = {
  "Remove-Item": [
    ...COMMON,
    { name: "Confirm", switch: true, aliases: ["cf"] },
    { name: "Credential" },
    { name: "Exclude" },
    { name: "Filter" },
    { name: "Force", switch: true },
    { name: "Include" },
    { name: "LiteralPath", aliases: ["PSPath", "LP"] },
    { name: "Path" },
    { name: "Recurse", switch: true },
    { name: "Stream" },
    { name: "UseTransaction", switch: true, aliases: ["usetx"] },
    { name: "WhatIf", switch: true, aliases: ["wi"] },
  ],
}

// A word naming a command, optionally qualified by its module (`Microsoft.PowerShell.Management\Remove-Item`).
const COMMAND_NAME = /^(?:[A-Za-z][\w.]*\\)?([A-Za-z][\w]*(?:-[A-Za-z][\w]*)?|[%?])$/
// A parameter word, with the value it is given after a colon (`-Recurse:$false`).
const PARAMETER = /^-([A-Za-z_?][\w?]*)(?::(.*))?$/s

// The command written as WORDS, which keep their quoting, spelled as the cmdlet it runs: an alias or a cmdlet named by
// its module as the cmdlet's own name, and each parameter of a cmdlet listed above under its full name, a switch set
// with `:$true` written bare. Rules match command text, so one rule then sees each way of writing the command. None
// when the words name no cmdlet listed here.
export function spellings(words: readonly string[]): string[] {
  const name = cmdlet(words[0])
  if (!name) return []
  const parameters = PARAMETERS[name]
  const end = words.indexOf("--")
  const spelled = words
    .slice(1)
    .map((word, index) => (parameters && (end < 0 || index + 1 < end) ? parameter(word, parameters) : word))
  return [[name, ...spelled].join(" ")]
}

// The cmdlet WORD runs, when it names one listed here.
export function cmdlet(word: string | undefined) {
  const match = word === undefined ? null : COMMAND_NAME.exec(unquoted(word))
  if (!match) return
  const name = match[1].toLowerCase()
  return ALIASES[name] ?? CMDLETS.get(name)
}

// WORD without the quotes of a literal string, which PowerShell runs as the command it names (`& 'Remove-Item'`).
function unquoted(word: string) {
  const quoted = /^'([^']*)'$/.exec(word) ?? /^"([^"`$]*)"$/.exec(word)
  return quoted ? quoted[1] : word
}

function parameter(word: string, parameters: readonly Parameter[]) {
  const match = PARAMETER.exec(word)
  const found = match ? resolve(match[1], parameters) : undefined
  if (!match || !found) return word
  const value = match[2]
  if (value === undefined || (found.switch && /^\$true$/i.test(value))) return `-${found.name}`
  return `-${found.name}:${value}`
}

// The parameter WRITTEN names: the one whose name or alias it is, else the only one whose name or alias it begins.
function resolve(written: string, parameters: readonly Parameter[]) {
  const lower = written.toLowerCase()
  const names = (item: Parameter) => [item.name, ...(item.aliases ?? [])].map((name) => name.toLowerCase())
  const exact = parameters.find((item) => names(item).includes(lower))
  if (exact) return exact
  const prefixed = parameters.filter((item) => names(item).some((name) => name.startsWith(lower)))
  return prefixed.length === 1 ? prefixed[0] : undefined
}
