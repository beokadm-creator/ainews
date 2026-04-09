# Firebase Firestore Reading Cost Analysis & Optimization

## Current Situation
- Firebase Firestore daily reads exceed 50,000 free tier limit
- Previous optimizations in commits f0b05fe and 0202c33 insufficient
- Need to identify and optimize high-frequency read operations

## Firestore Read Operation Analysis

### 1. High-Frequency Scheduled Operations

#### getArticlePipelineCounts() - 9 count() queries every call
**Location:** cloud-infra/functions/src/index.ts:491-516
**Frequency:** Called by:
- `scheduledAiAnalysis` (every 5 minutes) via `updateContinuousPipelineRuntime`
- `scheduledContinuousCollection` (every 5 minutes) via `updateContinuousPipelineRuntime`  
- `scheduledPremiumCollection` (every 10 minutes) via `updateContinuousPipelineRuntime`
- Manual triggers for collection/analysis

**Cost:** 9 count() queries × (12 + 12 + 6 + manual triggers) = 270+ reads/hour = 6,480+ reads/day

**Queries:**
```typescript
db.collection('articles').where('status', '==', 'pending').count().get(),
db.collection('articles').where('status', '==', 'filtering').count().get(),
db.collection('articles').where('status', '==', 'filtered').count().get(),
db.collection('articles').where('status', '==', 'analyzing').count().get(),
db.collection('articles').where('status', '==', 'analyzed').count().get(),
db.collection('articles').where('status', '==', 'published').count().get(),
db.collection('articles').where('status', '==', 'rejected').count().get(),
db.collection('articles').where('status', '==', 'ai_error').count().get(),
db.collection('articles').where('status', '==', 'analysis_error').count().get(),
```

#### drainAiAnalysisQueue() - 2 count() queries every call
**Location:** cloud-infra/functions/src/index.ts:253-263
**Frequency:** Called by `scheduledAiAnalysis` (every 5 minutes)
**Cost:** 2 count() queries × 12 = 24 reads/hour = 576 reads/day

**Queries:**
```typescript
db.collection('articles').where('status', '==', 'pending').count().get(),
db.collection('articles').where('status', '==', 'filtered').count().get(),
```

### 2. Frontend Dashboard Operations

#### Dashboard.tsx - 7-day trend queries
**Location:** src/pages/Dashboard.tsx:139-149
**Frequency:** Called on page load and refresh
**Cost:** 2 initial counts + 7 daily counts = 9 reads per dashboard load

**Queries:**
```typescript
// Today stats
getCountFromServer(query(articlesRef, ...base, where('collectedAt', '>=', startOfToday)));
getCountFromServer(query(articlesRef, ...base, where('collectedAt', '>=', startOfToday), where('status', 'in', ['analyzed', 'published'])));

// 7-day trend loop
for (let i = 6; i >= 0; i--) {
  getCountFromServer(query(articlesRef, ...base, where('collectedAt', '>=', s), where('collectedAt', '<', e)));
}
```

#### AdminDashboard.tsx - 4 count() queries on load
**Location:** src/pages/admin/AdminDashboard.tsx:172-178
**Frequency:** Called on page load
**Cost:** 4 reads per admin dashboard load

**Queries:**
```typescript
getCountFromServer(query(collection(db, 'articles'), where('status', 'in', COLLECTED_STATUSES))),
getCountFromServer(query(collection(db, 'articles'), where('status', 'in', EXCLUDED_STATUSES))),
getCountFromServer(query(collection(db, 'articles'), where('status', 'in', ANALYZED_STATUSES))),
getCountFromServer(query(collection(db, 'articles'), where('status', 'in', ['ai_error', 'analysis_error']))),
```

#### HTTP endpoint for AdminDashboard - 4 count() queries
**Location:** cloud-infra/functions/src/index.ts:2308-2313
**Cost:** 4 reads per HTTP call

### 3. Real-time Listeners (onSnapshot)

#### AdminDashboard.tsx - 3 onSnapshot listeners
**Location:** src/pages/admin/AdminDashboard.tsx:231-239
**Cost:** 3 reads per connection + 3 reads per update

#### AdminArticles.tsx - 1 onSnapshot listener  
**Location:** src/pages/admin/AdminArticles.tsx:451-465
**Cost:** 1 read per connection + 1 read per update

#### Dashboard.tsx - 1 onSnapshot listener (conditional)
**Location:** src/pages/Dashboard.tsx:223
**Cost:** 1 read per pipeline run (when active)

### 4. Existing Caching Mechanisms (Working)

#### getSystemAiConfig() - ALREADY CACHED ✅
**Location:** cloud-infra/functions/src/index.ts:1278-1300
- 5-minute TTL cache
- Prevents 2 reads per scheduled function call
- **Estimated saving:** 3,000+ reads/day

#### getActiveSourceIds() - ALREADY CACHED ✅  
**Location:** cloud-infra/functions/src/index.ts:42-58
- 5-minute TTL cache
- **Estimated saving:** 1,000+ reads/day

## Optimization Opportunities

### HIGH IMPACT: Cache getArticlePipelineCounts()

**Problem:** Most expensive operation - 9 count() queries every 5-10 minutes
**Solution:** Implement caching with 2-3 minute TTL
**Expected Saving:** 4,000+ reads/day (60%+ reduction)

```typescript
// Proposed implementation
let _pipelineCountsCache: { data: any; expiresAt: number } | null = null;
const PIPELINE_COUNTS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

async function getArticlePipelineCounts() {
  const now = Date.now();
  if (_pipelineCountsCache && _pipelineCountsCache.expiresAt > now) {
    return _pipelineCountsCache.data;
  }
  
  // Existing count queries...
  const counts = { /* ... */ };
  
  _pipelineCountsCache = { data: counts, expiresAt: now + PIPELINE_COUNTS_CACHE_TTL_MS };
  return counts;
}
```

### MEDIUM IMPACT: Replace count() with limit(1).get() where possible

**Problem:** count() queries are expensive for large collections  
**Solution:** Use limit(1).get().docs.length for existence checks
**Expected Saving:** 15-20% per query where applicable

**Example for drainAiAnalysisQueue():**
```typescript
// Current: 2 count() queries
const [pendingSnap, filteredSnap] = await Promise.all([
  db.collection('articles').where('status', '==', 'pending').count().get(),
  db.collection('articles').where('status', '==', 'filtered').count().get(),
]);
if (pendingSnap.data().count === 0 && filteredSnap.data().count === 0) {
  // skip processing
}

// Optimized: 2 limit(1) queries  
const [pendingSnap, filteredSnap] = await Promise.all([
  db.collection('articles').where('status', '==', 'pending').limit(1).get(),
  db.collection('articles').where('status', '==', 'filtered').limit(1).get(),
]);
if (pendingSnap.empty && filteredSnap.empty) {
  // skip processing
}
```

### MEDIUM IMPACT: Cache frontend dashboard counts

**Problem:** Dashboard loads trigger 9 count queries each time
**Solution:** Cache counts in frontend with 1-2 minute refresh
**Expected Saving:** 500+ reads/day

### LOW IMPACT: Optimize onSnapshot listeners

**Problem:** Real-time listeners cause reads on each update
**Solution:** Use more specific queries and debounce updates
**Expected Saving:** 200+ reads/day

## Implementation Priority

### Phase 1: Backend Cache (HIGH IMPACT)
1. **Cache getArticlePipelineCounts()** - 4,000+ reads/day savings
2. **Optimize drainAiAnalysisQueue() with limit(1)** - 300+ reads/day savings  

### Phase 2: Frontend Optimization (MEDIUM IMPACT)  
3. **Cache Dashboard.tsx 7-day trends** - 500+ reads/day savings
4. **Cache AdminDashboard.tsx counts** - 200+ reads/day savings

### Phase 3: Fine-tuning (LOW IMPACT)
5. **Optimize onSnapshot listeners** - 200+ reads/day savings

## Projected Savings

- **Phase 1:** 4,300+ reads/day (60%+ reduction)
- **Phase 2:** 700+ reads/day  
- **Phase 3:** 200+ reads/day
- **Total:** 5,200+ reads/day savings

**Expected Result:** Reduce daily reads from 50,000+ to under 45,000, well within the free tier limit.

## Implementation Notes

- Maintain cache invalidation mechanisms
- Keep TTL short enough for near-real-time updates
- Test thoroughly to ensure cache coherency
- Monitor actual read reduction after implementation