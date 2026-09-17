import React from 'react';
import { VStack } from '@astryxdesign/core/VStack';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';

/* Catches render crashes anywhere below it and shows a friendly fallback
   instead of a blank page. There is deliberately no auto-retry: a render
   crash will just crash again, so the user gets a clean reload button. */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error, info) {
    // Still goes to the console for debugging; the fallback is for the user.
    console.error('Stargazer crashed:', error, info);
  }

  render() {
    if (this.state.crashed) {
      return (
        <VStack
          gap={3}
          hAlign="center"
          vAlign="center"
          style={{ minHeight: '70vh', padding: 24, textAlign: 'center' }}
        >
          <Text type="display-3">The sky glitched.</Text>
          <Text type="supporting">
            Something broke while loading Stargazer. Reloading usually fixes it.
          </Text>
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </VStack>
      );
    }
    return this.props.children;
  }
}
