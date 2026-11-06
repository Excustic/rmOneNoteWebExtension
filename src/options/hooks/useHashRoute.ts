import { useCallback, useEffect, useState } from 'react';
import {
  getRouteDefinition,
  type OptionsRouteId,
  parseOptionsHash,
} from '../../shared/routes';

export function useHashRoute(): {
  route: OptionsRouteId;
  navigate: (nextRoute: OptionsRouteId) => void;
} {
  const [route, setRoute] = useState<OptionsRouteId>(() =>
    parseOptionsHash(window.location.hash),
  );

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseOptionsHash(window.location.hash));
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

  useEffect(() => {
    document.title = getRouteDefinition(route).pageTitle;
  }, [route]);

  const navigate = useCallback((nextRoute: OptionsRouteId) => {
    window.location.hash = nextRoute;
  }, []);

  return { route, navigate };
}

