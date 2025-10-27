# Agent Settings UI Rebuild Plan

## Current Issues

- Messy UI after multiple refactors
- Provider selection unclear
- Model configuration duplicated
- OpenRouter's vast model selection not well-supported
- Advanced settings cluttering the main view

## Goals

1. **Primary providers**: Ollama Cloud, OpenRouter
2. **OpenRouter**: Prominent custom model input (vast selection)
3. **Cleaner layout**: Remove duplicates, better organization
4. **Better UX**: Clear visual hierarchy, collapsible sections

## New Structure

### 1. Provider Selection (Global)

- **Visual card/radio buttons** for: Ollama Cloud | OpenRouter | OpenAI | Anthropic
- Show provider icon and selection state
- Single source of truth (no duplicates)

### 2. Planner Configuration

```text
[Section Card]
Title: Planner (Reasoning & Planning)

- Profile dropdown: gpt-oss, claude-sonnet, etc.
- Profile description

Model Selection:
  ( ) Use preset model
      [Dropdown: if presets available]

  (*) Use custom model ID  <-- Radio, not toggle
      [Text input: full width, prominent]
      [Helper text for OpenRouter: examples]
```

### 3. Actor Configuration

- Same structure as Planner
- Separate card for visual separation

### 4. System Settings

```text
[Section Card]
Title: System Settings

- [x] Two-Phase Planner
    Generate structured TaskSpec before plan (experimental)

- [x] Safe Mode
    Disable all code generation

Keystore: [Status indicator] [Unlock/Lock button]
```

### 5. Advanced Settings (Collapsible)

- Behind "Show Advanced" toggle
- Contains: Wizard, Container Security, Code Providers, Network, Modules

## Key Changes from Current

### ModelSelector Component

**Before**: Toggle buttons, confusing preset/custom switching
**After**:

- Radio buttons for mode selection
- OpenRouter defaults to custom with examples
- Cleaner validation and error display

### Provider Selection

**Before**: Dropdown in nested card with confusing hierarchy
**After**:

- Visual cards with icons
- Clear active state
- Grid layout (2x2 or 4x1)

### Overall Layout

**Before**: Mixed sections, unclear grouping
**After**:

- Clear cards for each major section
- Consistent spacing and styling
- Better visual hierarchy

## Implementation Phases

### Phase 1: ModelSelector Rebuild (done)

- Add radio buttons for preset/custom
- OpenRouter special handling
- Better placeholder text
- Remove toggle buttons

### Phase 2: Provider Selection (done)

- Card-based UI with icons
- Grid layout
- Click to select

### Phase 3: Planner/Actor Cards (done)

- Separate cards
- Cleaner model configuration
- Remove old nested structure

### Phase 4: System Settings Card (done)

- Group Two-Phase, Safe Mode, Keystore
- Simpler layout

### Phase 5: Advanced Collapse (done)

- Move wizard/security/network behind toggle
- Keep core settings visible

## Backend Capabilities Supported

### Per Provider (from agents.yaml schema)

- (done) base_url
- (done) headers (with env vars)
- (done) model_aliases (presets)
- (done) list_models (optional API)

### Per Profile (planner/actor)

- provider (string)
- model (alias or direct ID)
- temperature (0-2)
- max_tokens
- fallbacks (supported by schema; may be added to UI later)

Note: UI offers a "preset" vs "custom" mode for convenience, but agents.yaml persists a single `model` field that can be either an alias or a concrete ID.

### Recommended for Users

1. **Provider switching** - Easy Ollama <-> OpenRouter toggle
2. **Custom models** - Especially for OpenRouter's vast catalog
3. **Presets** - Quick selection for common models
4. **Temperature** - (Advanced) Control randomness
5. **Max tokens** - (Advanced) Control output length
6. **Safe Mode** - Emergency kill switch for codegen

## Visual Design Notes

### Colors

- Primary: Emerald (emerald-600) for actions/selected
- Neutral: Slate grays for text
- Borders: slate-200 for cards
- BG: white for cards, slate-50 for nested

### Spacing

- Card padding: p-4 (16px)
- Gap between cards: gap-4 (16px)
- Internal spacing: gap-3 (12px)

### Icons

- Ollama
- OpenRouter
- OpenAI
- Anthropic
