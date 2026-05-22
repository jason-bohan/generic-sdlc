$body = Get-Content './_ollama-req.json' -Raw
try {
    $r = Invoke-RestMethod -Uri 'http://localhost:11434/api/generate' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120
    Write-Output $r.response
    Write-Output "---TOKENS---"
    Write-Output "prompt_eval_count: $($r.prompt_eval_count)"
    Write-Output "eval_count: $($r.eval_count)"
} catch {
    Write-Output "ERROR: $($_.Exception.Message)"
}
