import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ComputeDemoWindow from '../../src/components/ComputeDemoWindow';
import { useAppStore } from '../../src/state/app';

describe('ComputeDemoWindow workspace form', () => {
  beforeEach(() => {
    useAppStore.setState({ computeDemoOpen: true });
  });

  it('exposes workspace path field with stable id and name', () => {
    render(<ComputeDemoWindow />);
    const field = screen.getByLabelText(/Workspace file path/i);
    expect(field).toHaveAttribute('id', 'compute-demo-workspace-path');
    expect(field).toHaveAttribute('name', 'workspacePath');
  });
});

