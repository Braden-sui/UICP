# Enhanced TaskSpec Examples

## Overview

The enhanced TaskSpec is the **BRAIN** of the UICP planning pipeline. It performs comprehensive technical analysis BEFORE any code is written, serving as the single source of truth for all downstream phases.

## Architecture Change

### Before: Split Analysis
```
User Request
  → TaskSpec (basic field parsing)
  → Planner (DOES ALL ANALYSIS + translation)
  → Actor
```

**Problem**: Planner did both deep thinking AND translation, making it slow and prone to inconsistency.

### After: Separation of Concerns
```
User Request
  → TaskSpec (COMPREHENSIVE DEEP ANALYSIS - the "brain")
  → Planner (translation only - TaskSpec → UICP ops)
  → Actor
```

**Solution**: TaskSpec does ALL the deep thinking, Planner just translates to operations.

## Field Comparison

### Basic TaskSpec (Old)
```json
{
  "user_intent": "string",
  "goals": ["..."],
  "constraints": ["..."],
  "artifacts": ["..."],
  "contexts": ["..."],
  "actions": [...],
  "acceptance": ["..."],
  "priority": "normal"
}
```

**8 fields** - mostly just categorizing the request into buckets.

### Enhanced TaskSpec (New)
```json
{
  // Core Intent
  "user_intent": "string",
  "priority": "low|normal|high",

  // Requirements Analysis (existing, enhanced)
  "goals": ["..."],
  "constraints": ["..."],
  "artifacts": ["..."],
  "contexts": ["..."],
  "acceptance": ["..."],

  // Edge Cases & Error Handling (NEW)
  "edge_cases": ["..."],
  "error_scenarios": [
    {"scenario": "...", "handling": "..."}
  ],

  // Data Model Design (NEW)
  "data_model": {
    "state_keys": [
      {"scope": "window|workspace|global", "key": "...", "type": "...", "purpose": "..."}
    ],
    "data_flow": "...",
    "data_structures": ["..."]
  },

  // UI/UX Specification (NEW)
  "ui_specification": {
    "window": {"id": "...", "title": "...", "size": "..."},
    "layout_description": "...",
    "interactions": ["..."],
    "accessibility_notes": ["..."]
  },

  // Dependencies & Blockers (NEW)
  "dependencies": {
    "required_state": ["..."],
    "required_windows": ["..."],
    "required_apis": [
      {"url": "...", "method": "...", "purpose": "..."}
    ],
    "blockers": ["..."]
  },

  // Assumptions & Questions (NEW)
  "assumptions": ["..."],
  "open_questions": ["..."],

  // Implementation Planning (NEW)
  "implementation_phases": [
    {"phase": 1, "description": "...", "deliverables": ["..."], "complexity": "..."}
  ],

  // Action Hints (existing)
  "actions": [...]
}
```

**15+ field groups** - comprehensive technical specification capturing ALL aspects of implementation.

## Example 1: Simple Request - "Create a notes window"

### User Request
```
Create a notes window with editable text and a Save button.
```

### Enhanced TaskSpec Output

```json
{
  "user_intent": "Create a notes window with editable text area and Save button for persisting notes",
  "priority": "normal",

  "goals": [
    "User can view and edit notes in a dedicated window",
    "User can save notes to workspace state",
    "User receives visual feedback on save success"
  ],

  "constraints": [
    "Must sanitize HTML in note content",
    "Save button must use declarative data-command (no inline JS)",
    "Window must have deterministic id for idempotency"
  ],

  "artifacts": [
    "Window: win-notes",
    "State: window.note.text (current edit)",
    "State: workspace.lastNote (saved note)"
  ],

  "contexts": [
    "No existing windows required",
    "No dependencies on prior state"
  ],

  "acceptance": [
    "Window 'win-notes' exists with title 'Session Notes'",
    "Textarea binds to window state key 'note.text'",
    "Save button data-command includes state.set to workspace.lastNote",
    "Status div updates to 'Saved' after save",
    "No inline JS handlers present",
    "Window id is deterministic (re-run creates same window, not duplicate)"
  ],

  "edge_cases": [
    "Empty note text (should still allow saving)",
    "Very long note text (no explicit character limit needed for MVP)",
    "Rapid clicking Save button (state.set is idempotent)",
    "Window already exists (window.create should be idempotent or use update)",
    "Sanitization strips essential formatting (use plain textarea to avoid)"
  ],

  "error_scenarios": [
    {
      "scenario": "State.set fails to write to workspace",
      "handling": "Show error in status div: 'Save failed - try again'"
    },
    {
      "scenario": "Window creation fails",
      "handling": "Throw error to user - critical operation"
    }
  ],

  "data_model": {
    "state_keys": [
      {
        "scope": "window",
        "key": "note.text",
        "type": "string",
        "purpose": "Current content being edited in textarea"
      },
      {
        "scope": "workspace",
        "key": "lastNote",
        "type": "string",
        "purpose": "Most recently saved note (persists across window sessions)"
      }
    ],
    "data_flow": "User types → textarea updates window.note.text → Save button clicked → state.set writes to workspace.lastNote → status updates",
    "data_structures": [
      "note.text: string (plain text content)",
      "lastNote: string (saved plain text)"
    ]
  },

  "ui_specification": {
    "window": {
      "id": "win-notes",
      "title": "Session Notes",
      "size": "md"
    },
    "layout_description": "Vertical stack layout: H1 heading ('Session Notes'), full-width textarea (40 rows), status div with polite aria-live, primary Save button at bottom",
    "interactions": [
      "Textarea: binds to window state 'note.text' via data-state-scope/key attributes",
      "Save button: triggers data-command batch [state.set workspace.lastNote, dom.replace status]",
      "Status div: shows 'Ready' initially, 'Saved' after save"
    ],
    "accessibility_notes": [
      "Textarea has implicit label from H1 context",
      "Save button has explicit aria-label='Save'",
      "Status div has aria-live='polite' and role='status' for screen reader announcements",
      "Semantic HTML (textarea, button, not divs)"
    ]
  },

  "dependencies": {
    "required_state": [],
    "required_windows": [],
    "required_apis": [],
    "blockers": []
  },

  "assumptions": [
    "Single note at a time (not a list/collection)",
    "No persistence beyond workspace scope (no backend API)",
    "Plain text notes (no rich formatting needed)",
    "No auto-save (user explicitly clicks Save)",
    "No delete/clear functionality in MVP"
  ],

  "open_questions": [
    "Should notes persist across app restarts? (assuming no for MVP)",
    "Should there be a character limit? (assuming no for MVP)",
    "Should there be auto-save on window close? (assuming no for MVP)"
  ],

  "implementation_phases": [
    {
      "phase": 1,
      "description": "Core window with edit and save functionality",
      "deliverables": [
        "Window created with deterministic id",
        "Textarea bound to window state",
        "Save button functional",
        "Status feedback working"
      ],
      "complexity": "simple"
    }
  ],

  "actions": [
    {
      "tool": "window.create",
      "params": {
        "id": "win-notes",
        "title": "Session Notes",
        "size": "md"
      },
      "description": "Create the notes window container",
      "reason": "Establishes the UI container with deterministic id"
    },
    {
      "tool": "dom.set",
      "params": {
        "windowId": "win-notes",
        "target": "#root",
        "html": "<div class='stack gap-3'><h1>Session Notes</h1><textarea id='note' class='w-full h-40' data-state-scope='window' data-state-key='note.text' required></textarea><div id='status' aria-live='polite' role='status'>Ready</div><button id='save' class='btn btn-primary' aria-label='Save' data-command='[{\"op\":\"state.set\",\"params\":{\"scope\":\"workspace\",\"key\":\"lastNote\",\"value\":\"{{value}}\"}},{\"op\":\"dom.replace\",\"params\":{\"windowId\":\"win-notes\",\"target\":\"#status\",\"html\":\"Saved\"}}]'>Save</button></div>"
      },
      "description": "Scaffold the complete UI structure",
      "reason": "Single dom.set operation includes all UI elements with proper state bindings and command wiring"
    }
  ]
}
```

### How Planner Uses This TaskSpec

The Planner receives the above TaskSpec and translates it to a plan:

```javascript
emit_plan({
  "summary": "Show a notes window with editable text and a Save action", // from goals

  "risks": [
    "edge: empty note text (allow saving)",                              // from edge_cases
    "edge: rapid save clicks (idempotent state.set handles)",            // from edge_cases
    "edge: window already exists (window.create idempotent)",            // from edge_cases
    "gui: Actor sanitizes user HTML input",                              // from constraints
    "unclear: should notes persist across restarts?"                     // from open_questions
  ],

  "actor_hints": [
    "window.create: id=\"win-notes\", title=\"Session Notes\", size=\"md\"",  // from actions[0]
    "dom.set: windowId=\"win-notes\", target=\"#root\", html=\"...\"",        // from actions[1]
    // (hints directly translate TaskSpec actions into UICP operation strings)
  ],

  "batch": []
})
```

**Key point**: Planner does NO analysis - just translates TaskSpec fields into the emit_plan format.

## Example 2: Complex Request - "Create a task tracker with filters"

### User Request
```
Create a task tracking window that shows a list of tasks.
Users should be able to filter by status (all/active/completed)
and add new tasks via a form.
```

### Enhanced TaskSpec Output (Abbreviated)

```json
{
  "user_intent": "Create interactive task tracking window with filterable task list and add-task form",
  "priority": "normal",

  "goals": [
    "User can view list of tasks",
    "User can filter tasks by status",
    "User can add new tasks",
    "UI updates reactively to filter changes"
  ],

  "edge_cases": [
    "Empty task list (show empty state message)",
    "Filter with no matching tasks (show 'no tasks' message)",
    "Adding task with empty title (validate, show error)",
    "Rapid filter clicks (state.set + watch handles)",
    "Task list grows very large (consider pagination in future, show all for MVP)"
  ],

  "error_scenarios": [
    {
      "scenario": "Form submitted with empty title",
      "handling": "Prevent submission, show inline validation error 'Task title required'"
    },
    {
      "scenario": "State watch fails to trigger re-render",
      "handling": "Manual dom.replace fallback after state.set"
    }
  ],

  "data_model": {
    "state_keys": [
      {
        "scope": "workspace",
        "key": "tasks.items",
        "type": "array",
        "purpose": "Array of task objects [{id, title, status, created}, ...]"
      },
      {
        "scope": "window",
        "key": "tasks.filter",
        "type": "string",
        "purpose": "Current filter: 'all' | 'active' | 'completed'"
      },
      {
        "scope": "window",
        "key": "tasks.nextId",
        "type": "number",
        "purpose": "Auto-incrementing ID for new tasks"
      }
    ],
    "data_flow": "Filter button clicked → state.set filter → state.watch triggers → dom.replace task list with filtered items. Add form submitted → state.set append to tasks.items → state.watch triggers → dom.replace task list",
    "data_structures": [
      "task: {id: number, title: string, status: 'active'|'completed', created: timestamp}",
      "tasks.items: task[]",
      "tasks.filter: 'all'|'active'|'completed'"
    ]
  },

  "ui_specification": {
    "window": {
      "id": "win-tasks",
      "title": "Task Tracker",
      "size": "lg"
    },
    "layout_description": "3-section vertical layout: (1) Header with H1 + filter buttons, (2) Task list (ul/li) with conditional rendering, (3) Add task form at bottom",
    "interactions": [
      "Filter buttons: All/Active/Completed - each sets window.tasks.filter",
      "Task list: renders filtered subset of workspace.tasks.items",
      "Add form: input for title, submit button",
      "Form submission: appends new task to workspace.tasks.items, increments nextId"
    ],
    "accessibility_notes": [
      "Filter buttons in toolbar with role='group' and aria-label='Filter tasks'",
      "Current filter button has aria-pressed='true'",
      "Task list uses semantic ul/li",
      "Each task has checkbox for status toggle (future enhancement)",
      "Form has explicit label for title input"
    ]
  },

  "dependencies": {
    "required_state": [],
    "required_windows": [],
    "required_apis": [],
    "blockers": []
  },

  "assumptions": [
    "Tasks stored in workspace state only (no persistence API)",
    "Tasks identified by auto-incrementing ID (no UUIDs needed)",
    "No edit/delete functionality in MVP",
    "No due dates, priorities, or tags in MVP",
    "Filter applies on client-side (no backend filtering)"
  ],

  "open_questions": [
    "Should tasks persist across app restarts? (assuming no for MVP)",
    "Should tasks have completion timestamps? (not for MVP)",
    "Should completed tasks be archivable/hideable permanently? (not for MVP)"
  ],

  "implementation_phases": [
    {
      "phase": 1,
      "description": "Basic task list display with hardcoded sample tasks",
      "deliverables": [
        "Window created",
        "Static task list rendered",
        "Filter buttons present but non-functional"
      ],
      "complexity": "simple"
    },
    {
      "phase": 2,
      "description": "Filter functionality with state management",
      "deliverables": [
        "Filter buttons functional",
        "Task list updates on filter change",
        "State.watch triggers re-render"
      ],
      "complexity": "moderate"
    },
    {
      "phase": 3,
      "description": "Add task form with validation",
      "deliverables": [
        "Form input and submit button",
        "Validation on empty title",
        "New tasks append to list",
        "Task list re-renders after add"
      ],
      "complexity": "moderate"
    }
  ],

  "actions": [
    {
      "tool": "window.create",
      "params": {"id": "win-tasks", "title": "Task Tracker", "size": "lg"}
    },
    {
      "tool": "state.set",
      "params": {"scope": "workspace", "key": "tasks.items", "value": []},
      "description": "Initialize empty task array",
      "reason": "Ensure tasks.items exists before rendering"
    },
    {
      "tool": "state.set",
      "params": {"scope": "window", "key": "tasks.filter", "value": "all"},
      "description": "Set default filter to 'all'",
      "reason": "Establish initial filter state"
    },
    {
      "tool": "state.set",
      "params": {"scope": "window", "key": "tasks.nextId", "value": 1},
      "description": "Initialize task ID counter",
      "reason": "Auto-incrementing IDs for new tasks"
    },
    {
      "tool": "dom.set",
      "params": {
        "windowId": "win-tasks",
        "target": "#root",
        "html": "<!-- Complex HTML with filter toolbar, task list ul, and add form -->"
      },
      "description": "Scaffold complete UI structure",
      "reason": "Single operation to establish all UI containers and controls"
    },
    {
      "tool": "state.watch",
      "params": {"scope": "window", "key": "tasks.filter"},
      "description": "Watch filter changes to trigger re-render",
      "reason": "Reactive update of task list when filter changes"
    }
  ]
}
```

## Benefits Demonstrated

### 1. Edge Cases Identified Early
- Empty states
- Validation failures
- Rapid interactions
- Idempotency concerns

**Impact**: Prevents bugs before coding starts.

### 2. Data Model Designed Upfront
- Clear state scope decisions (window vs workspace)
- Data types specified
- Data flow documented

**Impact**: Prevents state management issues and refactoring.

### 3. UI/UX Fully Specified
- Layout described
- Interactions documented
- Accessibility built-in from start

**Impact**: Consistent, accessible UI with no rework.

### 4. Assumptions & Questions Surfaced
- What's assumed vs. known is explicit
- Ambiguities raised early
- User can clarify before implementation

**Impact**: Reduces mid-implementation surprises and scope creep.

### 5. Implementation Phased for Complex Tasks
- Large tasks broken into increments
- Each phase delivers working functionality
- Complexity assessed upfront

**Impact**: Better estimation and incremental delivery.

### 6. Planner Simplified
- Planner just translates TaskSpec to operations
- No re-analysis needed
- Faster, more consistent plans

**Impact**: Faster planning, higher quality consistency.

## Summary

| Aspect | Old TaskSpec | Enhanced TaskSpec |
|--------|-------------|-------------------|
| **Role** | Parse request into categories | Comprehensive technical analysis |
| **Fields** | 8 basic fields | 15+ specialized field groups |
| **Analysis Depth** | Shallow categorization | Deep thinking (edge cases, errors, data model, UI/UX) |
| **Planner Role** | Analysis + translation | Translation only |
| **Single Source of Truth** | Split between TaskSpec & Planner | All in TaskSpec |
| **Error Prevention** | Minimal | Comprehensive edge case coverage |
| **Data Design** | Ad-hoc in Planner | Explicit in TaskSpec data_model |
| **UI Spec** | Vague hints | Detailed ui_specification |
| **Assumptions** | Implicit | Explicit assumptions & open_questions |
| **Complex Tasks** | No phasing | implementation_phases for breakdown |

**Result**: TaskSpec is now the true "brain" - making Planner a fast, deterministic translator.
