import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Button } from './Button';
import { InputField, SearchField, TextareaField } from './Field';
import { Card, CardHeader, CardBody, CardFooter } from './Card';
import { Modal } from './Modal';
import { Tabs, type TabItem } from './Tabs';
import { Badge } from './Badge';
import { EmptyState } from './EmptyState';
import { SelectMenu } from './SelectMenu';
import './primitives.css';

const PlusIcon: React.FC = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);

const SparkIcon: React.FC = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3l1.9 4.7L18.5 9.5l-4.6 1.8L12 16l-1.9-4.7L5.5 9.5l4.6-1.8z" />
  </svg>
);

export const UiKitPreview: React.FC = () => {
  const [activeTab, setActiveTab] = useState('overview');
  const [modalOpen, setModalOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [selectedModel, setSelectedModel] = useState('claude-sonnet');
  const [selectedCard, setSelectedCard] = useState<'alpha' | 'beta'>('beta');

  const tabItems: TabItem[] = [
    {
      id: 'overview',
      label: 'Overview',
      badge: <Badge tone="accent" shape="pill">3</Badge>,
      content: (
        <Card padding="sm">
          <CardBody>
            <span>Overview tab panel — token-driven surfaces and 4 px grid rhythm.</span>
          </CardBody>
        </Card>
      ),
    },
    {
      id: 'controls',
      label: 'Controls',
      content: (
        <Card padding="sm">
          <CardBody>
            <span>Controls tab panel — 26 px, 32 px, and 38 px control heights.</span>
          </CardBody>
        </Card>
      ),
    },
    {
      id: 'tokens',
      label: 'Tokens',
      content: (
        <Card padding="sm">
          <CardBody>
            <span>Tokens tab panel — zero hardcoded hexes and zero arbitrary radii.</span>
          </CardBody>
        </Card>
      ),
    },
  ];

  return (
    <main className="kite-uikit" data-testid="ui-kit-root">
      <div className="kite-uikit__inner">
        <header className="kite-uikit__header">
          <div>
            <h1 className="kite-uikit__title">Kite Core UI Primitives</h1>
            <p className="kite-uikit__subtitle">
              Semantic visual-language gallery for automated design and layout verification.
            </p>
          </div>
          <div className="kite-uikit__row">
            <Badge tone="success" shape="pill" dot>
              Token-only
            </Badge>
            <Button
              variant="primary"
              data-testid="ui-kit-open-modal"
              onClick={() => setModalOpen(true)}
            >
              Open Modal
            </Button>
          </div>
        </header>

        <section className="kite-uikit__grid" aria-label="Buttons and Badges">
          <Card>
            <CardHeader>
              <strong>Buttons</strong>
              <Badge tone="neutral">4 variants</Badge>
            </CardHeader>
            <CardBody>
              <div className="kite-uikit__row" data-testid="ui-kit-button-row">
                <Button variant="primary">Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger">Danger</Button>
              </div>
              <div className="kite-uikit__row">
                <Button size="sm">Small 26</Button>
                <Button size="md">Medium 32</Button>
                <Button size="lg">Large 38</Button>
                <Button iconOnly aria-label="Add item" leftIcon={<PlusIcon />} />
              </div>
              <div className="kite-uikit__row">
                <Button variant="primary" disabled>
                  Disabled
                </Button>
                <Button variant="secondary" loading>
                  Loading
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <strong>Badges &amp; SelectMenu</strong>
              <Badge tone="accent" shape="pill">
                Live
              </Badge>
            </CardHeader>
            <CardBody>
              <div className="kite-uikit__row">
                <Badge tone="neutral">Neutral</Badge>
                <Badge tone="accent" dot>
                  Accent
                </Badge>
                <Badge tone="success" shape="pill" dot>
                  Success
                </Badge>
                <Badge tone="warning" shape="pill">
                  Warning
                </Badge>
                <Badge tone="danger">Danger</Badge>
              </div>
              <SelectMenu
                label="Default Model"
                value={selectedModel}
                triggerLabel={
                  [
                    { id: 'claude-sonnet', title: 'Claude Sonnet' },
                    { id: 'gpt-5', title: 'GPT-5' },
                    { id: 'gemini-pro', title: 'Gemini Pro' },
                  ].find((r) => r.id === selectedModel)?.title ?? 'Claude Sonnet'
                }
                onSelect={setSelectedModel}
                rows={[
                  { id: 'claude-sonnet', title: 'Claude Sonnet', detail: 'Balanced speed' },
                  { id: 'gpt-5', title: 'GPT-5', detail: 'Deep reasoning' },
                  { id: 'gemini-pro', title: 'Gemini Pro', detail: 'Long context' },
                ]}
              />
            </CardBody>
          </Card>
        </section>

        <section className="kite-uikit__grid" aria-label="Fields">
          <Card>
            <CardHeader>
              <strong>Fields — Default</strong>
            </CardHeader>
            <CardBody>
              <InputField
                label="Workspace Name"
                placeholder="kite-desktop"
                hint="Lowercase letters, numbers, and dashes."
                required
              />
              <SearchField
                label="Quick Search"
                placeholder="Filter commands..."
                shortcut="⌘K"
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                onClear={() => setSearchValue('')}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <strong>Fields — Validation &amp; Textarea</strong>
            </CardHeader>
            <CardBody>
              <InputField
                label="API Endpoint"
                defaultValue="http://invalid"
                error="Must use https:// for remote endpoints."
              />
              <TextareaField
                label="Agent Instructions"
                placeholder="Describe expected output..."
                error="Instructions cannot be empty."
              />
            </CardBody>
          </Card>
        </section>

        <section className="kite-uikit__stack" aria-label="Tabs and Cards">
          <Tabs
            data-testid="ui-kit-tabs"
            ariaLabel="UI Kit sections"
            items={tabItems}
            value={activeTab}
            onChange={setActiveTab}
          />

          <div className="kite-uikit__grid">
            <Card
              interactive
              selected={selectedCard === 'alpha'}
              onClick={() => setSelectedCard('alpha')}
            >
              <CardHeader>
                <strong>Interactive Card</strong>
                <Badge tone="neutral">Rest</Badge>
              </CardHeader>
              <CardBody>
                <span>Click to select this surface card.</span>
              </CardBody>
              <CardFooter>
                <Button size="sm" variant="ghost">
                  Inspect
                </Button>
              </CardFooter>
            </Card>

            <Card
              interactive
              selected={selectedCard === 'beta'}
              onClick={() => setSelectedCard('beta')}
            >
              <CardHeader>
                <strong>Selected Card</strong>
                <Badge tone="accent" dot>
                  Active
                </Badge>
              </CardHeader>
              <CardBody>
                <span>Accent focus border and 1 px semantic ring.</span>
              </CardBody>
              <CardFooter>
                <Button size="sm" variant="primary">
                  Confirm
                </Button>
              </CardFooter>
            </Card>
          </div>
        </section>

        <section className="kite-uikit__grid" aria-label="Empty States">
          <EmptyState
            icon={<SparkIcon />}
            title="No active runs"
            description="Launch an agent task to stream live progress and diffs here."
            action={
              <Button variant="primary" size="sm">
                New Run
              </Button>
            }
          />
          <EmptyState
            tone="error"
            icon={<SparkIcon />}
            title="Connection interrupted"
            description="Unable to reach the local runtime daemon. Retry or inspect logs."
            action={
              <Button variant="danger" size="sm">
                Retry
              </Button>
            }
          />
        </section>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Configure Runtime Gate"
        description="Verify dialog overlay radius, backdrop blur, and Escape dismissal."
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setModalOpen(false)}>
              Save Changes
            </Button>
          </>
        }
      >
        <InputField label="Gate Profile" defaultValue="standard" />
        <TextareaField label="Notes" placeholder="Optional verification notes..." />
      </Modal>
    </main>
  );
};

export function renderUiKitPreview(root: HTMLElement): void {
  if (typeof document !== 'undefined') {
    document.body.classList.add('kite-app');
    document.documentElement.setAttribute('data-boot-released', '1');
    document.getElementById('boot')?.remove();
  }
  ReactDOM.createRoot(root).render(<UiKitPreview />);
}
