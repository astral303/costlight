[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $DashboardArguments
)

$ErrorActionPreference = 'Stop'

$miseCommand = Get-Command mise -ErrorAction Stop
& $miseCommand.Source install
if ($LASTEXITCODE -ne 0) {
    throw "mise install failed with exit code $LASTEXITCODE."
}

& $miseCommand.Source run start -- @DashboardArguments
if ($LASTEXITCODE -ne 0) {
    throw "Dashboard startup failed with exit code $LASTEXITCODE."
}
