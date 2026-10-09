import defaultMdxComponents from "@fumadocs/base-ui/mdx";
import { Accordion, Accordions } from "@fumadocs/base-ui/components/accordion";
import { Callout } from "@fumadocs/base-ui/components/callout";
import { Card, Cards } from "@fumadocs/base-ui/components/card";
import { Step, Steps } from "@fumadocs/base-ui/components/steps";
import { Tab, Tabs } from "@fumadocs/base-ui/components/tabs";
import {
  Bot,
  Eye,
  File,
  Flag,
  FlaskConical,
  Globe,
  ListChecks,
  Map,
  MessageSquare,
  Palette,
  Server,
  Shield,
  Terminal,
  Wrench,
} from "lucide-react";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps, ReactNode } from "react";

// The vendored Claude Code whitepaper is authored with Mintlify-style MDX
// components. Map them onto fumadocs base-ui primitives so the pages render.
const iconMap: Record<string, ReactNode> = {
  toolbox: <Wrench />,
  terminal: <Terminal />,
  "shield-halved": <Shield />,
  shield: <Shield />,
  server: <Server />,
  robot: <Bot />,
  palette: <Palette />,
  map: <Map />,
  "list-check": <ListChecks />,
  globe: <Globe />,
  "flask-vial": <FlaskConical />,
  flask: <FlaskConical />,
  flag: <Flag />,
  file: <File />,
  eye: <Eye />,
  comments: <MessageSquare />,
};

type CalloutProps = ComponentProps<typeof Callout>;

const Note = (props: CalloutProps) => <Callout type="info" {...props} />;
const Tip = (props: CalloutProps) => <Callout type="idea" {...props} />;
const Info = (props: CalloutProps) => <Callout type="info" {...props} />;
const Warning = (props: CalloutProps) => <Callout type="warning" {...props} />;

type MintCardProps = ComponentProps<typeof Card> & { icon?: string };
function MintCard({ icon, children, description, ...rest }: MintCardProps) {
  return (
    <Card
      icon={typeof icon === "string" ? iconMap[icon] : icon}
      description={description ?? children}
      {...rest}
    />
  );
}

type CardGroupProps = ComponentProps<typeof Cards> & { cols?: number };
function CardGroup({ cols: _cols, ...rest }: CardGroupProps) {
  return <Cards {...rest} />;
}

const AccordionGroup = (props: ComponentProps<typeof Accordions>) => (
  <Accordions {...props} />
);

function MintStep({
  title,
  children,
}: {
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Step>
      {title ? <p className="mb-1 font-medium">{title}</p> : null}
      {children}
    </Step>
  );
}

function Frame({
  caption,
  children,
}: {
  caption?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <figure className="my-4">
      {children}
      {caption ? (
        <figcaption className="mt-2 text-center text-xs text-fd-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    AccordionGroup,
    Tabs,
    Tab,
    Callout,
    Note,
    Tip,
    Info,
    Warning,
    Card: MintCard,
    CardGroup,
    Steps,
    Step: MintStep,
    Frame,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
