import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Sparkles } from 'lucide-react';

export default function DomainInputStep({
  domain,
  onDomainChange,
  onSubmit,
  loading,
  recentDomains,
  disabled = false,
}: {
  domain: string;
  onDomainChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
  recentDomains: string[];
  disabled?: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="domain-input" className="text-sm font-medium">
          Enter a domain or niche
        </label>
        <Input
          id="domain-input"
          placeholder='e.g., "AI and Technology"'
          value={domain}
          onChange={(e) => onDomainChange(e.target.value)}
          disabled={loading || disabled}
        />
      </div>
      <Button type="submit" disabled={loading || disabled || !domain.trim()}>
        {loading ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Finding topics...
          </>
        ) : (
          <>
            <Sparkles className="size-4" />
            Find Trending Topics
          </>
        )}
      </Button>
      {recentDomains.length > 0 && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">Recent searches</p>
          <div className="flex flex-wrap gap-1.5">
            {recentDomains.map((d) => (
              <Button
                key={d}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onDomainChange(d)}
                disabled={loading || disabled}
              >
                {d}
              </Button>
            ))}
          </div>
        </div>
      )}
    </form>
  );
}
