[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $CostlightArguments
)

$ErrorActionPreference = 'Stop'

$miseCommand = Get-Command mise -ErrorAction Stop
& $miseCommand.Source install
if ($LASTEXITCODE -ne 0) {
    throw "mise install failed with exit code $LASTEXITCODE."
}

& $miseCommand.Source run start -- @CostlightArguments
if ($LASTEXITCODE -ne 0) {
    throw "Costlight startup failed with exit code $LASTEXITCODE."
}
