# Open Questions - Documentation Audit

Generated: 2025-01-21 20:00:00 UTC

## Purpose

This document captures questions raised during the documentation audit that require clarification or further investigation.

---

## Critical Questions Requiring Immediate Attention

### 1. Agents Loader Test Failure
**File**: `uicp/src/lib/agents/loader.test.ts`  
**Issue**: Test fails with "Failed to resolve import 'yaml'"  
**Location**: `loader.ts:1` imports from 'yaml'  
**Question**: 
- Is the `yaml` package properly installed?
- Should this dependency be in `package.json` dependencies or devDependencies?
- Is this a test environment issue or a missing dependency?

**Evidence**: 
- Test output shows: `Error: Failed to resolve import "yaml" from "src/lib/agents/loader.ts"`
- `package.json` shows `"yaml": "^2.5.0"` in dependencies
- May be a module resolution issue in test environment

**Action Required**: Fix test failure and verify dependency installation

---

## Documentation Questions

### 2. Module Count Discrepancy
**Files**: Multiple docs mention "14 modules"  
**Issue**: `uicp/src/lib/uicp/adapters/` contains 26+ TypeScript files  
**Question**: 
- Do "modules" refer to logical modules vs files?
- Should documentation list actual file count?
- What is the correct way to count adapter modules?

**Evidence**:
- Directory listing shows 26+ files
- Documentation claims "14 modules"
- Some files may be utilities vs core modules

**Action Required**: Clarify module counting methodology

### 3. Setup Documentation Completeness
**File**: `docs/setup.md`  
**Status**: Not fully examined during audit  
**Question**: 
- Are all setup steps documented?
- Do environment variable requirements match actual code?
- Are platform-specific instructions accurate?

**Action Required**: Complete audit of setup documentation

### 4. Security Enhancement Plan
**File**: `docs/security-enhancement-plan.md`  
**Status**: Not examined during audit  
**Question**: 
- Does the plan match implemented security measures?
- Are planned enhancements actually complete?
- What is the current security posture?

**Action Required**: Cross-check plan with implementation

---

## Technical Questions

### 5. Test Count Automation
**Issue**: Test counts in documentation frequently drift from reality  
**Question**: 
- Should test counts be generated dynamically?
- What mechanism would prevent future drift?
- Should CI fail if docs don't match test output?

**Evidence**: Found multiple outdated test count references across 3 files

**Action Required**: Implement automated test count updates

### 6. Adapter Module Line Counts
**File**: `docs/ADAPTER_V2_COMPLETE.md`  
**Issue**: Module line counts may not match actual file sizes  
**Question**: 
- Are the documented line counts accurate?
- Should they be verified programmatically?
- Do counts matter for documentation purposes?

**Evidence**: Claims like "lifecycle.ts ~300 lines" but not verified

**Action Required**: Either verify counts or remove specific numbers

---

## Architectural Questions

### 7. Feature Flag Status
**Issue**: Documentation mentions feature flags that may no longer exist  
**Questions**:
- Are `VITE_WIL_ONLY` and `VITE_TOOLS_ONLY` still in use?
- What is the current default behavior?
- Are there other feature flags not documented?

**Evidence**: Found references to `supportsTools` and `wilOnly` in code

**Action Required**: Verify feature flag documentation accuracy

### 8. Tool Calling Status
**File**: Multiple docs discuss JSON tool calling  
**Question**: 
- Is JSON tool calling still WIP or production?
- What is the current fallback behavior?
- Are success rates documented anywhere?

**Evidence**: Documentation suggests production default but needs verification

**Action Required**: Clarify tool calling production status

---

## Methodology Questions

### 9. Evidence Tagging Policy
**Question**: Should all documentation sections have evidence tags?  
**Current State**: Not all sections have evidence tags  
**Action Required**: Define evidence tagging requirements

### 10. Documentation Maintenance
**Question**: How should documentation be kept in sync with code?  
**Current State**: Manual updates prone to drift  
**Action Required**: Establish maintenance workflow

---

## Resolved During Audit

### ✅ Test Count Discrepancy
**Status**: RESOLVED  
**Resolution**: Updated all test count references from 267 to 382+  
**Files Updated**: `docs/README.md`, `docs/ADAPTER_V2_COMPLETE.md`

### ✅ Historical Documentation
**Status**: VERIFIED  
**Resolution**: Archive and legacy docs properly marked as deprecated  
**Files**: All files in `docs/archive/` and `docs/legacy/`

---

## Questions Requiring Code Investigation

These questions require examining code that wasn't fully traced during the audit:

1. How does the agents YAML loader handle missing files?
2. What is the actual adapter module organization?
3. Are there undocumented feature flags?
4. What is the complete list of environment variables?
5. How does the compute plane handle module loading?

---

## Recommendations for Closing Open Questions

1. **Code Investigation**: Run targeted searches for specific claims
2. **File System Analysis**: Verify file/directory structure matches docs
3. **Runtime Verification**: Test documented features in dev environment
4. **Test Execution**: Run full test suite and verify documented counts
5. **Dependency Analysis**: Check package.json for all dependencies

---

## Tracking

Questions will be tracked until resolved:
- Add answers to this document as they are discovered
- Link to implementation or documentation updates
- Remove resolved questions after verification
- Document methodology for future audits

