import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UserProfile from '../dashboard/UserProfile';

describe('UserProfile', () => {
  it('renders name, email and bio', () => {
    render(<UserProfile displayName="Test User" email="test@example.com" bio="This is a short bio." />);
    expect(screen.getByRole('heading', { name: /profile/i })).toBeDefined();
    expect(screen.getByText('Test User')).toBeDefined();
    expect(screen.getByText('test@example.com')).toBeDefined();
    expect(screen.getByText(/short bio/i)).toBeDefined();
  });
});

