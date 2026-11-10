/**
 * Tasks Module for CollabSuite
 * Entry point - exports all task-related functionality
 */

// This module aggregates all task functionality
// Import order matters - dependencies first

// State management for tasks
window.TaskState = {
    currentTaskId: null,
    currentProjectId: null,
    tasks: [],
    members: [],
    isDetailOpen: false,
    expandedTasks: [] // Track which tasks have subtasks expanded
};

// Re-export all task functions to window scope
// (actual implementations in other files)
