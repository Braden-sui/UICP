import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OnboardingWelcomeModal from '../OnboardingWelcomeModal';
import { useAppStore } from '../../state/app';
import { useKeystore } from '../../state/keystore';
import type { ProviderId } from '../../lib/providers/setupGuides';

const appInitialState = { ...useAppStore.getState() };
const keystoreInitialState = { ...useKeystore.getState() };

const setupAppStore = () => {
  const setWelcomeCompletedMock = vi.fn((value: boolean) => {
    useAppStore.setState({ welcomeCompleted: value });
  });
  const pushToastMock = vi.fn();
  useAppStore.setState({
    welcomeCompleted: false,
    setWelcomeCompleted: setWelcomeCompletedMock,
    pushToast: pushToastMock,
  });
  return { setWelcomeCompletedMock, pushToastMock };
};

const setupKeystoreStore = (overrides?: Partial<ReturnType<typeof useKeystore.getState>>) => {
  const refreshStatusMock = vi.fn(async () => undefined);
  const refreshIdsMock = vi.fn(async () => useKeystore.getState().knownIds);
  const saveProviderKeyMock = vi.fn(async (provider: ProviderId, _key: string) => {
    useKeystore.setState({ knownIds: [`env:uicp:${provider}:api_key`] });
    return true;
  });

  useKeystore.setState({
    locked: false,
    ttlRemainingSec: null,
    method: null,
    busy: false,
    error: undefined,
    knownIds: [],
    refreshStatus: refreshStatusMock,
    refreshIds: refreshIdsMock,
    saveProviderKey: saveProviderKeyMock,
  });

  if (overrides) {
    useKeystore.setState(overrides as Partial<ReturnType<typeof useKeystore.getState>>);
  }

  return { refreshStatusMock, refreshIdsMock, saveProviderKeyMock };
};

describe('OnboardingWelcomeModal', () => {
  afterEach(() => {
    useAppStore.setState(appInitialState, true);
    useKeystore.setState(keystoreInitialState, true);
  });

  it('renders the welcome intro when no providers are saved', async () => {
    setupAppStore();
    setupKeystoreStore();

    render(<OnboardingWelcomeModal />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to UICP')).toBeInTheDocument();
    });
  });

  it('saves a provider key and completes onboarding', async () => {
    const { setWelcomeCompletedMock, pushToastMock } = setupAppStore();
    const { saveProviderKeyMock } = setupKeystoreStore();

    render(<OnboardingWelcomeModal />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to UICP')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Get Started' }));

    await waitFor(() => {
      expect(screen.getByText('Add your API keys')).toBeInTheDocument();
    });

    const keyInput = screen.getAllByPlaceholderText('Paste API key')[0];
    await user.type(keyInput, 'sk-test');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(saveProviderKeyMock).toHaveBeenCalledWith('openai', 'sk-test');
    });

    await waitFor(() => {
      expect(screen.getByText('Saved securely.')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(screen.getByText('You are all set')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => {
      expect(setWelcomeCompletedMock).toHaveBeenCalledWith(true);
      expect(pushToastMock).toHaveBeenCalled();
    });
  });

  it('does not render when onboarding is already completed', async () => {
    setupAppStore();
    setupKeystoreStore();
    useAppStore.setState({ welcomeCompleted: true });

    render(<OnboardingWelcomeModal />);

    await waitFor(() => {
      expect(screen.queryByText('Welcome to UICP')).not.toBeInTheDocument();
    });
  });
});
