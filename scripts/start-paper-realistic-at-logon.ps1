$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
& (Join-Path $PSScriptRoot "start-paper-realistic.ps1") `
    -Root $Root `
    -StateRoot "state-paper-realistic" `
    -JournalRoot "tmp/paper-realistic-journals" `
    -Strategy "new-token-v1" `
    -MaxActivePositions 5 `
    -TickIntervalMs 10000 `
    -HotTickIntervalMs 2000

exit $LASTEXITCODE
