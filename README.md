# 🤖 EcoSync Bot • SGA 360° (Central Desktop & Robô de Banco de Dados)

Aplicação desktop profissional com interface moderna (Electron, Node.js e Python) e robô de automação local (**EcoSync Bot**) para sincronização bidirecional entre o **Banco de Dados Local** (PostgreSQL) e o **Banco de Dados de Produção** (Coolify / Remoto), desenvolvida sob rigorosas camadas de segurança e as **10 Heurísticas de Usabilidade de Nielsen**.

---

## 🧠 Recursos Inteligentes v1.1.0 (EcoSync Bot)

- **Identidade Própria & Estado Dinâmico:** Avatar exclusivo (`assets/icon.png` / `assets/icon.ico`) e indicador de humor em tempo real na barra lateral (*Vigilante*, *Piloto Ativo*, *Atenção*, *Sincronizando...*, *Offline*).
- **EcoSync Smart Advisor:** Analisa automaticamente divergências, saúde de tuplas mortas, locks em espera e acúmulo de backups, sugerindo ações rápidas com 1 clique.
- **Raio-X do Banco PostgreSQL & Schema Inspector:** Monitora tamanho em MB/KB, *Cache Hit Ratio (%)*, conexões ativas/máximas, *waiting locks*, *live/dead tuples*, *seq/idx scans* e último *autovacuum*. Clicar em qualquer tabela abre o **Schema Inspector** (colunas, PK, chaves estrangeiras e índices).
- **Seleção Granular de Tabelas (`--tables`):** Permite sincronizar ou simular tabelas específicas diretamente pela aba de Sincronização.
- **Robô Autônomo Integrado:** Agendador interno (`scheduler.json`) com intervalos configuráveis, contagem regressiva ao vivo e modo inteligente (*só sincroniza se houver divergência*), além do comando pronto para o Agendador de Tarefas do Windows (`taskschd.msc`).
- **Paginação Completa:** Paginação configurável (5, 8, 10, 20 ou 50 itens/página) no Dashboard, Comparador Diff, Raio-X do Banco, Backups de Produção, Backups Locais e Trilha de Auditoria.
- **Limpeza de Retenção:** Botão para manter automaticamente os 10 snapshots mais recentes em cada pasta de backup.

---

## 🌟 Recursos Visuais & Usabilidade (Leis de Nielsen)

1. **Visibilidade do status do sistema**:
   - Status pills pulsantes na barra superior com latência (ping em ms) em tempo real para os dois bancos.
   - Terminal de streaming de logs em tempo real durante a execução transacional com auto-scroll.
2. **Correspondência com o mundo real**:
   - Nomenclatura clara: "Local (Seu computador)" ➜ "Produção (Coolify / Nuvem)", setas de fluxo e termos compreensíveis.
3. **Controle e liberdade do usuário**:
   - Botão **Simulação Prévia (Dry-Run)** para conferir diferenças sem alterar nada.
   - Botão **Cancelar** para interromper processos em andamento.
   - Snapshots automáticos de segurança mantidos em `backups_prod/` e `backups_local/`.
4. **Consistência e padrões**:
   - Design System escuro profissional inspirado em interfaces modernas (Linear / Vercel), ícones consistentes e cores semânticas padronizadas.
5. **Prevenção de erros**:
   - Modal de confirmação inteligente antes de aplicar qualquer alteração real no banco de dados.
   - Desativação preventiva de botões quando conexões estiverem offline ou em processo.
6. **Reconhecimento em vez de memorização**:
   - Cards de métricas com totais de linhas, tabelas e integridade sempre visíveis.
   - Tabela de comparação lado a lado (Local vs Coolify) com busca instantânea.
7. **Flexibilidade e eficiência de uso**:
   - Ação rápida de 1-clique **"Sincronizar PUSH"** na barra lateral.
   - Gestor visual das variáveis `.env` e teste imediato de rotas de rede.
8. **Estética e design minimalista**:
   - Interface limpa, alta densidade de informação sem poluição visual e animações sutis.
9. **Diagnóstico e recuperação de falhas**:
   - Mensagens claras de diagnóstico de rede, credenciais e portas em linguagem humana.
10. **Ajuda e documentação**:
    - Seção interna "Guia & Heurísticas" explicando o funcionamento do robô e este documento completo.

---

## 📂 Estrutura de Arquivos

```text
C:\Projetos\Robô Banco\
├── assets/
│   ├── icon.png          # Ícone oficial do EcoSync Bot (PNG)
│   └── icon.ico          # Ícone multi-resolução para o app e executável Windows
├── src/
│   ├── index.html        # Estrutura HTML da aplicação desktop (CSP restrita)
│   ├── styles.css        # Design System escuro + paginação, gráficos e modais
│   └── renderer.js       # Lógica segura do frontend (sem innerHTML dinâmico)
├── main.js               # Processo principal do Electron (IPC, Scheduler e auditoria)
├── preload.js            # Bridge segura de comunicação IPC (contextBridge)
├── api_bridge.py         # Motor Python (status, insights, schema, diff, backups, limpeza)
├── sync_prod.py          # Script transacional de sincronização (Push/Pull/--tables)
├── package.json          # Manifesto do projeto Electron e scripts de build
├── iniciar_app.bat       # Atalho de 1-clique para iniciar o aplicativo Desktop
├── .env                  # Variáveis de conexão locais e de produção ativas
├── .env.example          # Modelo de variáveis de ambiente
├── .gitignore            # Proteção contra commit de credenciais, logs e agendador
├── backups_local/        # Histórico de backups gerados em operações PULL
├── backups_prod/         # Histórico de backups gerados em operações PUSH
└── logs/                 # Trilha imutável de auditoria (audit.jsonl)
```

---

## 🚀 Como Iniciar o Aplicativo Desktop

### Opção 1: Pelo Atalho (1-clique)
Dê um duplo clique no arquivo:
```text
C:\Projetos\Robô Banco\iniciar_app.bat
```

### Opção 2: Pelo Terminal
```bash
npm start
```

---

## 📦 Gerar Instalador Executável Independente (.exe)

Para empacotar a aplicação em um executável autônomo do Windows (instalador NSIS ou versão portátil):

```bash
npm run dist
```
Os executáveis serão gerados automaticamente na pasta `dist/`.

---

## ⏱️ Execução em Modo Robô (Linha de Comando / Agendador)

O robô pode continuar sendo acionado sem interface gráfica para tarefas agendadas no Windows:

```bash
# Diagnóstico de conexões
python sync_prod.py --check

# Simulação segura
python sync_prod.py --dry-run

# PUSH autônomo (Local -> Produção)
python sync_prod.py --push --yes

# PULL autônomo (Produção -> Local)
python sync_prod.py --pull --yes
```
