# Firestore Optimization Testing Checklist

## Backend Optimizations Testing

### 1. Pipeline Counts Caching
- [ ] Verify `getArticlePipelineCounts()` returns same data when called multiple times within 2 minutes
- [ ] Verify cache invalidation works after article processing
- [ ] Verify scheduled functions still work correctly
- [ ] Monitor actual Firestore read reduction in console

### 2. drainAiAnalysisQueue() Optimization  
- [ ] Verify function still skips processing when no articles exist
- [ ] Verify function processes articles when articles exist
- [ ] Verify limit(1).get() returns expected behavior vs count().get()

### 3. Cache Invalidation
- [ ] Verify cache invalidation is called after filtering operations
- [ ] Verify cache invalidation is called after analysis operations
- [ ] Verify manual triggers clear caches properly

## Frontend Optimizations Testing

### 1. Dashboard.tsx Trend Cache
- [ ] Verify 7-day trend loads correctly on first visit
- [ ] Verify cached data is used within 2 minutes
- [ ] Verify fresh data is fetched after cache expiry
- [ ] Verify chart displays correctly with cached data

### 2. AdminDashboard.tsx Counts Cache
- [ ] Verify article counts display correctly on first load
- [ ] Verify cached counts are used within 2 minutes  
- [ ] Verify refresh button clears cache and fetches fresh data
- [ ] Verify processing buttons clear cache after operations

## Integration Testing

### 1. End-to-End Pipeline
- [ ] Run full collection cycle and verify counts update
- [ ] Run analysis cycle and verify counts update
- [ ] Verify frontend dashboards reflect changes
- [ ] Verify real-time listeners still work

### 2. Performance Validation
- [ ] Monitor Firestore read count in Firebase console
- [ ] Verify reduction from baseline after optimizations
- [ ] Check for any new errors in cloud function logs
- [ ] Verify response times remain acceptable

## Expected Results

### Read Reduction
- **getArticlePipelineCounts()**: 60%+ reduction (4,000+ reads/day saved)
- **drainAiAnalysisQueue()**: 15-20% reduction per query
- **Dashboard trends**: 50%+ reduction on repeated loads
- **AdminDashboard counts**: 50%+ reduction on repeated loads

### Total Expected Savings
- **Daily reads**: Reduce from 50,000+ to under 45,000
- **Free tier compliance**: Should stay well within 50K free reads
- **Performance**: No degradation in user experience

## Rollback Plan
If issues are detected:
1. Revert cache implementations
2. Restore original count() queries in drainAiAnalysisQueue()
3. Remove cache invalidation calls
4. Monitor for stability

## Monitoring Points
- Firebase console read operations
- Cloud function execution logs
- Frontend error logs
- User experience feedback