import { createContext } from 'react';

export const TabBarContext = createContext({
  isTabBarHidden: true,
  setIsTabBarHidden: () => {},
});
