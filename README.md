# EUM News Platform

## Overview

EUM News Platform is a company-scoped AI news intelligence system for private equity, M&A, venture capital, and adjacent investment workflows.

The system is no longer built around a single fixed daily briefing flow. It now runs as a configurable execution engine where each company can define:

- source set
- date range
- keyword rules
- sector filters
- AI model and prompts
- output type

The pipeline collects articles, filters relevance with AI, analyzes only the relevant items, and produces a final output that can be either:

- an analysis report
- an article list
- a custom prompt-driven output

## Core Architecture

### 1. Tenant and role model

The platform now uses a hierarchy-based operating model:

- `superadmin`
  - creates and manages companies
  - assigns company admins
- `company_admin`
  - manages sources and company-level runtime settings
  - can run pipelines for their company
- `company_editor`
  - can operate company pipelines and content workflows
- `viewer`
  - read-only access

Each pipeline run is executed in a company context.

### 2. Runtime-driven pipeline

The main backend flow is:

1. load company runtime configuration
2. collect articles from active company sources
3. apply runtime filters
4. run AI relevance filtering
5. run deep analysis only for relevant articles
6. generate final output
7. persist run snapshot and output

The callable pipeline entrypoint is implemented in:

- [firebase/functions/src/index.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/index.ts)

Runtime configuration loading is implemented in:

- [firebase/functions/src/services/runtimeConfigService.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/services/runtimeConfigService.ts)
- [firebase/functions/src/types/runtime.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/types/runtime.ts)

## Key Features

### Company-scoped execution

All major pipeline stages now accept company and runtime context:

- RSS collection
- scraping collection
- Puppeteer collection
- AI relevance filtering
- AI deep analysis
- output generation

Relevant services:

- [firebase/functions/src/services/rssService.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/services/rssService.ts)
- [firebase/functions/src/services/scrapingService.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/services/scrapingService.ts)
- [firebase/functions/src/services/puppeteerService.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/services/puppeteerService.ts)
- [firebase/functions/src/services/aiService.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/services/aiService.ts)
- [firebase/functions/src/services/briefingService.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/services/briefingService.ts)

### Runtime filters

The engine supports runtime-configurable filtering instead of hardcoded logic:

- relative or absolute date range
- keywords
- required include keywords
- excluded keywords
- sector filters
- source selection

Shared filter utilities live in:

- [firebase/functions/src/utils/textUtils.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/utils/textUtils.ts)

### AI as the execution engine

The AI layer now works as the central decision engine for:

- relevance filtering
- structured article analysis
- final output generation

The AI runtime can vary by company through:

- model
- API key env binding
- relevance prompt
- analysis prompt
- output prompt
- batch sizing

### Generalized outputs

The system now writes final artifacts into `outputs` instead of assuming every run becomes a daily briefing.

Supported output types:

- `analysis_report`
- `article_list`
- `custom_prompt`

Output generation and persistence are handled in:

- [firebase/functions/src/services/briefingService.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/services/briefingService.ts)

## Data Model Direction

### Main collections

- `users`
- `companies`
- `sources`
- `articles`
- `pipelineRuns`
- `outputs`
- `sessions`
- `promptLogs`
- `aiCostTracking`

### Important persisted objects

`pipelineRuns`

- execution status
- triggering user
- company context
- full runtime config snapshot
- per-step status and timings

`articles`

- raw collected content
- company ownership
- pipeline run ownership
- AI relevance metadata
- deep analysis metadata
- output linkage

`outputs`

- output type
- article references
- raw output
- structured output
- company ownership
- pipeline linkage

## Security Changes

Firestore security rules were redesigned to remove the old over-permissive authenticated-write pattern.

The new rules enforce:

- company membership checks
- role-based access checks
- superadmin-only company and user administration
- restricted client writes for sensitive operational collections

Rules file:

- [firestore.rules](C:/Users/whhol/Documents/trae_projects/eum_news/firestore.rules)

Admin middleware was also updated to recognize the hierarchy model:

- [firebase/functions/src/utils/authMiddleware.ts](C:/Users/whhol/Documents/trae_projects/eum_news/firebase/functions/src/utils/authMiddleware.ts)

## Frontend Changes

The frontend was updated to align with the new execution model.

### Updated areas

- auth store now carries company and role metadata
- dashboard reads recent outputs
- output page reads from `outputs`
- history links to output artifacts
- manual entry can submit in company context
- layout reflects new role names

Relevant files:

- [src/store/useAuthStore.ts](C:/Users/whhol/Documents/trae_projects/eum_news/src/store/useAuthStore.ts)
- [src/pages/Dashboard.tsx](C:/Users/whhol/Documents/trae_projects/eum_news/src/pages/Dashboard.tsx)
- [src/pages/Briefing.tsx](C:/Users/whhol/Documents/trae_projects/eum_news/src/pages/Briefing.tsx)
- [src/pages/History.tsx](C:/Users/whhol/Documents/trae_projects/eum_news/src/pages/History.tsx)
- [src/pages/ManualEntry.tsx](C:/Users/whhol/Documents/trae_projects/eum_news/src/pages/ManualEntry.tsx)
- [src/components/Layout.tsx](C:/Users/whhol/Documents/trae_projects/eum_news/src/components/Layout.tsx)

## Local Development

### Install

```bash
npm install
cd firebase/functions
npm install
cd ../..
```

### Frontend env

Create `.env` in the project root:

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

### Functions env

Create `.env` under `firebase/functions`:

```env
GLM_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=...
```

### Type check

Frontend:

```bash
cmd /c npm run check
```

Functions:

```bash
cd firebase/functions
cmd /c npm run check
```

## Current Priority

The current product priority is the core execution engine, not scheduled delivery.

That means the most important supported flow is:

1. a company configures desired filters and prompts
2. the system scrapes and collects candidate articles
3. AI filters only relevant items
4. AI analyzes only the relevant items
5. the system generates the requested output form

Email and periodic sending remain secondary and can be refined later without changing the core engine model.

## Known Next Steps

The core engine is in place, but these areas should be continued next:

- migrate the remaining settings UI to company-scoped management
- add company creation and company admin assignment UI
- migrate any old `briefings` data into `outputs` if needed
- add explicit company selection UX for superadmin users
- refine scheduled execution to use company-managed scheduling metadata instead of fixed cron only
