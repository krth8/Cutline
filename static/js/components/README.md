# UI Components

Reusable UI components for CollabSuite. **Always check here before creating custom UI elements!**

---

## Quick Reference

| Component | Import | Common Use |
|-----------|--------|------------|
| [Dropdown](#dropdown) | `window.Dropdown` | Select menus, pickers |
| [DatePicker](#datepicker) | `window.DatePicker` | Date inputs |
| [Toast](#toast) | `window.Toast` | Notifications, feedback |
| [Confirm](#confirm) | `window.Confirm` | Delete confirmations |
| [Modal](#modal) | `window.Modal` | Dialogs, forms |
| [ColorPicker](#colorpicker) | `window.ColorPicker` | Color selection |
| [ContextMenu](#contextmenu) | `window.ContextMenu` | Right-click menus |
| [Avatar](#avatar) | `window.Avatar` | User avatars |
| [Badge](#badge) | `window.Badge` | Status pills, counts |

---

## Dropdown

Custom dropdown with search, multi-select, and animations.

```javascript
// Basic usage
const dropdown = new Dropdown({
    trigger: element,
    items: [
        { id: '1', label: 'Option 1' },
        { id: '2', label: 'Option 2', color: '#ff0000' }
    ],
    onSelect: (item) => console.log('Selected:', item)
});

// With search
new Dropdown({
    trigger: btn,
    items: users,
    searchable: true,
    searchPlaceholder: 'Find user...',
    onSelect: (item) => assignUser(item.id)
});

// Multi-select
new Dropdown({
    trigger: btn,
    items: tags,
    multiSelect: true,
    values: ['tag1', 'tag2'],
    onSelect: (values, item) => updateTags(values)
});

// Open programmatically
dropdown.open(anchorElement);
dropdown.close();
Dropdown.closeAll();
```

**Options:**
- `items` - Array of `{id, label, color?, icon?, image?}`
- `value` / `values` - Current selection
- `searchable` - Enable search filter
- `multiSelect` - Allow multiple selections
- `clearable` - Show clear option (default: true)
- `renderItem` - Custom item renderer function
- `minWidth`, `maxWidth`, `maxHeight` - Sizing

---

## DatePicker

Calendar date picker with quick presets.

```javascript
// Basic usage
const picker = new DatePicker({
    trigger: element,
    value: '2024-01-15',
    onSelect: (date) => console.log('Selected:', date) // YYYY-MM-DD
});

// Format for display
DatePicker.formatDisplay('2024-01-15'); // "Jan 15" or "Today"

// Open programmatically
picker.open(anchorElement);
picker.close();
DatePicker.closeAll();
```

**Options:**
- `value` - ISO date string (YYYY-MM-DD)
- `showPresets` - Show Today/Tomorrow/etc (default: true)
- `clearable` - Allow clearing date
- `minDate`, `maxDate` - Date constraints

---

## Toast

Notification toasts for user feedback.

```javascript
// Quick methods
Toast.success('Changes saved!');
Toast.error('Something went wrong');
Toast.warning('Are you sure?');
Toast.info('New update available');

// With options
Toast.show({
    message: 'File uploaded',
    type: 'success',
    duration: 5000,
    action: {
        label: 'View',
        onClick: () => openFile()
    }
});

// Dismiss
Toast.dismissAll();
```

**Types:** `success`, `error`, `warning`, `info`

---

## Confirm

Styled confirmation dialogs (replaces native `confirm()`).

```javascript
// Basic - returns Promise<boolean>
const confirmed = await Confirm.show('Delete this item?');
if (confirmed) { /* delete */ }

// Danger confirmation (red styling)
const confirmed = await Confirm.danger(
    'Are you sure you want to delete this project?',
    'Delete'
);

// Warning confirmation
const confirmed = await Confirm.warning(
    'This will reset all settings.',
    'Continue'
);

// Full options
const confirmed = await Confirm.show({
    title: 'Remove User',
    message: 'This user will lose access to all projects.',
    confirmText: 'Remove',
    cancelText: 'Keep',
    type: 'danger' // 'default', 'danger', 'warning'
});

// Alert (no cancel button)
await Confirm.alert('Operation completed!', 'OK');
```

---

## Modal

Generic modal dialog system.

```javascript
// Basic usage
const modal = new Modal({
    title: 'Edit User',
    content: '<form>...</form>',
    size: 'medium'
});
modal.open();

// With footer
const modal = new Modal({
    title: 'Settings',
    content: settingsHtml,
    footer: `
        <button class="btn btn-secondary" onclick="modal.close()">Cancel</button>
        <button class="btn btn-primary" onclick="saveSettings()">Save</button>
    `,
    size: 'large'
});

// Static method
Modal.open({
    title: 'Quick Modal',
    content: 'Hello world!'
});

// Update content dynamically
modal.setTitle('New Title');
modal.setContent('<p>Updated content</p>');
modal.setFooter('<button>Done</button>');

// Close
modal.close();
Modal.closeAll();
```

**Sizes:** `small` (360px), `medium` (520px), `large` (720px), `full` (95vw)

**Options:**
- `closable` - Show X button (default: true)
- `closeOnOverlay` - Click outside to close (default: true)
- `closeOnEscape` - Escape key closes (default: true)
- `onOpen`, `onClose` - Callbacks

---

## ColorPicker

Color swatch picker.

```javascript
const picker = new ColorPicker({
    trigger: element,
    value: '#3b82f6',
    onSelect: (color) => updateColor(color)
});

// Custom colors
new ColorPicker({
    trigger: btn,
    colors: ['#ff0000', '#00ff00', '#0000ff'],
    clearable: true,
    onSelect: (color) => { /* color or null */ }
});
```

**Default palette:** 20 colors (reds, oranges, greens, blues, purples, grays)

---

## ContextMenu

Right-click context menus.

```javascript
// Bind to element
ContextMenu.bind(element, [
    { label: 'Edit', icon: 'icon-pencil', action: () => edit() },
    { label: 'Duplicate', icon: 'icon-copy', action: () => duplicate() },
    { type: 'separator' },
    { label: 'Delete', icon: 'icon-trash', action: () => remove(), danger: true }
]);

// Show programmatically
ContextMenu.show(event.clientX, event.clientY, [
    { label: 'Option 1', action: () => {} },
    { type: 'header', label: 'Section' },
    { label: 'Option 2', shortcut: 'Ctrl+S', action: () => {} },
    { label: 'Disabled', disabled: true }
]);

// Dynamic items (function)
ContextMenu.bind(row, (event, element) => {
    return getContextMenuItems(element.dataset.id);
});

// Unbind
ContextMenu.unbind(element);
ContextMenu.close();
```

**Item properties:**
- `label` - Display text
- `icon` - Icon ID (e.g., 'icon-trash')
- `action` - Click handler
- `shortcut` - Keyboard shortcut display
- `danger` - Red styling
- `disabled` - Grayed out
- `type` - 'separator' or 'header'

---

## Avatar

Consistent user avatar rendering with initials and colors.

```javascript
// Render single avatar (returns HTML string)
const html = Avatar.render({
    name: 'John Doe',
    size: 'md'  // 'xs', 'sm', 'md', 'lg', 'xl'
});

// With image
Avatar.render({
    name: 'John Doe',
    image: '/avatars/john.jpg',
    size: 'lg'
});

// Stacked avatars (for assignees)
const stackHtml = Avatar.stack([
    { name: 'Alice' },
    { name: 'Bob', image: '/bob.jpg' },
    { name: 'Charlie' }
], { max: 3, size: 'sm' });

// Utility methods
Avatar.getInitials('John Doe');  // "JD"
Avatar.getColor('John Doe');     // consistent color for name
```

**Sizes:**
- `xs` - 20px (tiny indicators)
- `sm` - 24px (lists, compact)
- `md` - 32px (default)
- `lg` - 40px (profiles)
- `xl` - 56px (large displays)

---

## Badge

Badges and pills for status, counts, and labels.

```javascript
// Basic badge (returns HTML string)
Badge.render('Label', { variant: 'default' });

// Status badge with color
Badge.status('Approved', '#22c55e');
Badge.status('Pending', '#f59e0b');

// Version pill
Badge.version('1.2');  // "v1.2"
Badge.version(3);      // "v03"

// Notification count
Badge.count(5);        // shows "5"
Badge.count(150);      // shows "99+"

// Colored dot indicator
Badge.dot('#ef4444');  // red dot
```

**Variants:** `default`, `primary`, `success`, `warning`, `danger`, `info`

**Options:**
- `size` - 'sm' or 'md' (default: 'md')
- `variant` - Color variant
- `className` - Additional CSS classes

---

## CSS Classes

Common utility classes available globally:

```html
<!-- Buttons -->
<button class="btn btn-primary">Primary</button>
<button class="btn btn-secondary">Secondary</button>
<button class="btn btn-danger">Danger</button>
<button class="btn btn-ghost">Ghost</button>
<button class="btn btn-link">Link</button>

<!-- Icons -->
<svg class="icon"><use href="/static/icons.svg#icon-check"/></svg>
<svg class="icon icon-sm"><use href="/static/icons.svg#icon-x"/></svg>
<svg class="icon icon-lg"><use href="/static/icons.svg#icon-plus"/></svg>

<!-- Forms -->
<input class="input-large" type="text">
<select class="input-large">...</select>
<textarea class="input-large">...</textarea>
```

---

## Component Discovery

In development mode, open the browser console to see available components:

```javascript
// Auto-logged on page load in localhost
UIComponents.info();  // Manual call

// Check if a component exists
UIComponents.has('Dropdown');  // true
UIComponents.list();           // ['Dropdown', 'DatePicker', ...]
```

---

## Adding New Components

When creating a new reusable component:

1. Create file in `/static/js/components/`
2. Use class-based pattern with static methods where appropriate
3. Export to `window.ComponentName`
4. Add CSS to `/static/css/main.css` under component section
5. Add `<script>` tag to `index.html`
6. Add to `UIComponents` registry in `index.js`
7. **Update this README!**

### Component Template

```javascript
/**
 * Component Name
 * Brief description
 *
 * Usage:
 *   ComponentName.method(options);
 */

class ComponentName {
    static instances = new Map();

    constructor(options = {}) {
        this.id = options.id || `component-${Date.now()}`;
        // ...
    }

    open() { /* ... */ }
    close() { /* ... */ }
    destroy() { /* ... */ }

    static closeAll() { /* ... */ }
}

window.ComponentName = ComponentName;
```
