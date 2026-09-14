#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
exec 9>.git/update-server.lock
flock -n 9 || { echo 'Outra atualizacao esta em andamento.'; exit 1; }
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Existem alteracoes locais. Preserve e revise antes de atualizar:'
  git status --short
  exit 1
fi
[[ "$(git branch --show-current)" == main ]] || { echo 'Use a branch main.'; exit 1; }
[[ -z "$(git ls-files data)" ]] || { echo 'O banco nao pode estar versionado.'; exit 1; }
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  source "$NVM_DIR/nvm.sh"
  nvm use 24
fi
sudo -v
git fetch origin main
git merge-base --is-ancestor HEAD origin/main || { echo 'Historico divergente; revise antes de atualizar.'; exit 1; }
[[ -z "$(git ls-tree -r --name-only origin/main -- data)" ]] || { echo 'A atualizacao tenta versionar data; interrompido.'; exit 1; }
umask 077
stamp=$(date +%Y%m%d-%H%M%S)-$$
mkdir -p backups
git rev-parse HEAD > "backups/before-$stamp.commit"
node backend/manage.cjs backup "backups/before-$stamp.sqlite"
git merge --ff-only origin/main
npm ci
npm test
sudo systemctl restart gestao-plantao
sudo systemctl is-active --quiet gestao-plantao
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 2 --max-time 15 \
  -H 'Host: gestao-plantao.cor.rio' -H 'X-Forwarded-Proto: https' \
  http://127.0.0.1:3000/ -o /dev/null
echo 'Atualizacao concluida. Backup salvo em backups/.'
